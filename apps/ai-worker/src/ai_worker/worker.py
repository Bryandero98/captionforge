"""Consumidor de BullMQ: valida el payload, ejecuta el pipeline y deja el resultado en PostgreSQL.

Reglas (ADR 0006): un solo trabajo pesado a la vez en el proceso, nada pesado en el bucle de
eventos, cancelación cooperativa por Redis pub/sub, validación estricta del payload, sin
reintentos automáticos. Hay una cola por tipo de trabajo (transcribir y quemar) y las dos
comparten el mismo hueco de ejecución.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import threading
from collections.abc import Awaitable, Callable
from typing import Any

import redis.asyncio as aioredis
from bullmq import Worker
from captionforge_contracts import BurnJob, CancelMessage, JobError, TranscribeJob

from .burn import BurnRunner
from .config import WorkerConfig
from .db import JobRepository
from .errors import JobCancelled, JobFailure, classify
from .models import ModelProvider
from .progress import BURN_STAGE_RANGES, STAGE_RANGES, Progress
from .storage import Storage
from .transcribe import TranscribeRunner

log = logging.getLogger("ai_worker")

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_NIL_UUID = "00000000-0000-4000-8000-000000000000"


def failure_reason(job_id: str, failure: JobFailure) -> str:
    """JobError serializado: es el `failedReason` que lee el API (contrato job-error.v1)."""
    return JobError.model_validate(
        {
            "schemaVersion": 1,
            "jobId": job_id if _UUID.fullmatch(job_id) else _NIL_UUID,
            "errorCode": failure.code,
            "message": failure.message[:500],
        }
    ).model_dump_json()


class AiWorker:
    def __init__(
        self,
        config: WorkerConfig,
        repo: JobRepository | None = None,
        storage: Storage | None = None,
        models: ModelProvider | None = None,
    ) -> None:
        self.config = config
        self.repo = repo or JobRepository(config.database_url)
        self.storage = storage or Storage(config)
        self.models = models or ModelProvider()
        self.transcriber = TranscribeRunner(config, self.storage, self.models)
        self.burner = BurnRunner(config, self.storage)
        self._workers: list[Worker] = []
        self._cancel_task: asyncio.Task[None] | None = None
        self._cancel_events: dict[str, threading.Event] = {}
        # Whisper y ffmpeg usan toda la CPU: un trabajo a la vez por proceso, de cualquier cola.
        self._slot: asyncio.Semaphore | None = None

    # ------------------------------------------------------------------ trabajo
    async def process(self, job: Any, token: str, signal: Any) -> dict[str, Any]:
        """Procesador de la cola de transcripción."""
        return await self._process(job, signal, TranscribeJob, self.transcriber.run, STAGE_RANGES)

    async def process_burn(self, job: Any, token: str, signal: Any) -> dict[str, Any]:
        """Procesador de la cola de quemado."""
        return await self._process(job, signal, BurnJob, self.burner.run, BURN_STAGE_RANGES)

    async def _process(
        self,
        job: Any,
        signal: Any,
        model_type: Any,
        run: Callable[[Any, Progress, threading.Event], Awaitable[dict[str, Any]]],
        ranges: dict[str, tuple[float, float]],
    ) -> dict[str, Any]:
        job_id = str(job.id)
        try:
            # model_validate_json + strict: sin coerciones, igual de estricto que Ajv en el API.
            payload = model_type.model_validate_json(json.dumps(job.data), strict=True)
        except Exception as error:  # noqa: BLE001
            log.error("payload inválido en el trabajo %s: %s", job_id, type(error).__name__)
            failure = JobFailure("INTERNAL", f"Payload inválido: {type(error).__name__}")
            await self.repo.fail(job_id, failure.code, failure.message)
            raise Exception(failure_reason(job_id, failure)) from error
        if str(payload.jobId) != job_id:
            failure = JobFailure("INTERNAL", "El jobId del payload no coincide con el id del trabajo.")
            await self.repo.fail(job_id, failure.code, failure.message)
            raise Exception(failure_reason(job_id, failure))

        if self._slot is None:
            self._slot = asyncio.Semaphore(1)
        # El evento de cancelación se registra ANTES de esperar el hueco y de tomar el trabajo: el API
        # publica la cancelación en cuanto lo ve RUNNING, y un mensaje que llegara entre el claim y el
        # registro se perdería.
        cancel = threading.Event()
        self._cancel_events[job_id] = cancel
        try:
            async with self._slot:
                return await self._execute(job, job_id, payload, signal, run, ranges, cancel)
        finally:
            self._cancel_events.pop(job_id, None)

    async def _execute(
        self,
        job: Any,
        job_id: str,
        payload: Any,
        signal: Any,
        run: Callable[[Any, Progress, threading.Event], Awaitable[dict[str, Any]]],
        ranges: dict[str, tuple[float, float]],
        cancel: threading.Event,
    ) -> dict[str, Any]:
        if not await self.repo.claim(job_id):
            # Ya no estaba QUEUED: la API lo canceló mientras esperaba, o es una reentrega. No se procesa.
            log.info("trabajo %s ya no está en cola; se omite", job_id)
            failure = JobFailure("CANCELLED", "El trabajo ya no estaba pendiente.")
            raise Exception(failure_reason(job_id, failure))

        progress = Progress(
            self.repo, job_id, asyncio.get_running_loop(), sink=job, ranges=ranges, on_closed=cancel.set
        )
        runner = asyncio.create_task(run(payload, progress, cancel))
        aborted = asyncio.create_task(signal.wait())
        heartbeat = asyncio.create_task(self._heartbeat(job_id, cancel))
        try:
            await asyncio.wait({runner, aborted}, return_when=asyncio.FIRST_COMPLETED)
            if not runner.done():
                # Cancelación: se avisa al hilo de Whisper y se cancela la tarea (mata a ffmpeg).
                cancel.set()
                runner.cancel()
                with contextlib.suppress(asyncio.CancelledError, JobCancelled, Exception):
                    await runner
                raise JobCancelled()
            result = runner.result()
        except (JobCancelled, asyncio.CancelledError):
            await self.repo.fail(job_id, "CANCELLED", "Cancelado por el usuario.", cancelled=True)
            raise Exception(failure_reason(job_id, JobFailure("CANCELLED", "Cancelado por el usuario."))) from None
        except Exception as error:  # noqa: BLE001
            failure = classify(error)
            await self.repo.fail(job_id, failure.code, failure.message)
            raise Exception(failure_reason(job_id, failure)) from error
        finally:
            aborted.cancel()
            heartbeat.cancel()

        if not await self.repo.complete(job_id, result):
            # La fila ya no estaba RUNNING (la cerró el recolector o la API mientras trabajábamos): los
            # artefactos están en S3 pero PostgreSQL no los refleja. Que quede dicho, no en silencio.
            log.error("trabajo %s terminó pero su fila ya estaba cerrada; resultado no registrado: %s", job_id, result)
        return result

    async def _heartbeat(self, job_id: str, cancel: threading.Event) -> None:
        """Renueva `updatedAt` mientras el trabajo corre, con independencia de las etapas que informan progreso."""
        while True:
            await asyncio.sleep(self.config.heartbeat_seconds)
            try:
                if not await self.repo.touch(job_id):
                    log.warning("el trabajo %s ya no está en curso; se aborta", job_id)
                    cancel.set()
                    return
            except Exception:  # noqa: BLE001 - un latido fallido no debe tumbar el trabajo; el siguiente reintenta
                log.warning("no se pudo escribir el latido de %s", job_id, exc_info=True)

    # --------------------------------------------------------------- cancelación
    async def _listen_for_cancellations(self, subscribed: asyncio.Event) -> None:
        """Escucha el canal de cancelación para siempre: si Redis cae, reconecta con espera. Sin esto, un
        corte de Redis dejaba al worker procesando pero sordo a las cancelaciones, sin ningún aviso."""
        delay = 1.0
        while True:
            client = aioredis.Redis(
                host=self.config.redis_host,
                port=self.config.redis_port,
                password=self.config.redis_password,
                decode_responses=True,
            )
            pubsub = client.pubsub()
            try:
                await pubsub.subscribe(self.config.cancel_channel)
                subscribed.set()
                delay = 1.0
                async for message in pubsub.listen():
                    self._handle_cancel_message(message)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.error("se perdió la suscripción de cancelaciones; reintento en %.0f s", delay, exc_info=True)
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.aclose()
                    await client.aclose()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    def _handle_cancel_message(self, message: dict[str, Any]) -> None:
        if message["type"] != "message":
            return
        try:
            cancel = CancelMessage.model_validate_json(message["data"], strict=True)
        except Exception:  # noqa: BLE001 - un mensaje malformado se ignora, nunca tumba al worker
            log.warning("mensaje de cancelación ignorado (malformado)")
            return
        job_id = str(cancel.jobId)
        for worker in self._workers:
            worker.cancelJob(job_id, "cancelled")  # False si el trabajo no es de esa cola
        event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()

    # ------------------------------------------------------------------- ciclo
    def _close_interrupted(self, job_id: str) -> None:
        if not job_id:
            return
        # fail() es condicional (solo QUEUED/RUNNING): si el trabajo ya se cerró con su código real, no hace nada.
        task = asyncio.get_running_loop().create_task(
            self.repo.fail(job_id, "INTERNAL", "El trabajo se interrumpió inesperadamente.")
        )
        task.add_done_callback(lambda t: t.cancelled() or t.exception() is None or log.error("no se pudo cerrar %s", job_id))

    def _on_lock_lost(self, job_ids: Any, *_: Any) -> None:
        """No se pudo renovar el candado: otro worker puede tomar el trabajo. Se aborta el nuestro."""
        for job_id in job_ids if isinstance(job_ids, (list, tuple, set)) else [job_ids]:
            log.error("candado perdido en el trabajo %s; se aborta", job_id)
            event = self._cancel_events.get(str(job_id))
            if event is not None:
                event.set()

    def _on_failed(self, job: Any, error: Any, *_: Any) -> None:
        self._close_interrupted(str(getattr(job, "id", "")))

    def _on_stalled(self, job_id: Any, *_: Any) -> None:
        """Un worker murió a mitad de un trabajo (OOM, corte) y su candado venció. Con maxStalledCount=0
        BullMQ ya no lo reencola; aquí se cierra la fila para que el API no lo muestre RUNNING para siempre.
        Python de BullMQ emite `stalled` (con el id), no `failed`, para estos trabajos."""
        self._close_interrupted(str(job_id))

    def _new_worker(self, queue_name: str, processor: Callable[..., Awaitable[dict[str, Any]]]) -> Worker:
        worker = Worker(
            queue_name,
            processor,
            {
                "connection": self.config.redis_connection,
                "concurrency": self.config.concurrency,
                "lockDuration": self.config.lock_duration_ms,
                "stalledInterval": self.config.stalled_interval_ms,
                # Un trabajo atascado no se reencola solo (se reharía horas de cómputo): falla y se informa.
                "maxStalledCount": 0,
            },
        )
        worker.on("failed", self._on_failed)
        worker.on("error", lambda error, *_: log.error("error de BullMQ: %s", error))
        worker.on("lockRenewalFailed", self._on_lock_lost)
        worker.on("stalled", self._on_stalled)
        return worker

    async def start(self) -> None:
        self._workers = [
            self._new_worker(self.config.queue_name, self.process),
            self._new_worker(self.config.burn_queue_name, self.process_burn),
        ]
        subscribed = asyncio.Event()
        self._cancel_task = asyncio.create_task(self._listen_for_cancellations(subscribed))
        # Si Redis no está disponible al arrancar, fallar (y que Docker reinicie el proceso) en vez de quedarse
        # esperando sin consumir ni avisar.
        await asyncio.wait_for(subscribed.wait(), timeout=60)
        log.info("worker listo (colas %s y %s)", self.config.queue_name, self.config.burn_queue_name)

    async def stop(self) -> None:
        """Cierre ordenado: deja terminar el trabajo en curso (stop_grace_period del contenedor)."""
        for worker in self._workers:
            await worker.close()
        if self._cancel_task is not None:
            self._cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cancel_task
        await asyncio.to_thread(self.repo.close)
