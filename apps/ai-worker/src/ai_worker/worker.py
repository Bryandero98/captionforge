"""Consumidor de BullMQ: valida el payload, ejecuta el pipeline y deja el resultado en PostgreSQL.

Reglas (ADR 0006): concurrencia 1, nada pesado en el bucle de eventos, cancelación cooperativa por
Redis pub/sub, validación estricta del payload, sin reintentos automáticos.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import threading
from typing import Any

import redis.asyncio as aioredis
from bullmq import Worker
from captionforge_contracts import CancelMessage, JobError, TranscribeJob

from .config import WorkerConfig
from .db import JobRepository
from .errors import JobCancelled, JobFailure, classify
from .models import ModelProvider
from .progress import Progress
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
        self.runner = TranscribeRunner(config, self.storage, self.models)
        self._worker: Worker | None = None
        self._cancel_task: asyncio.Task[None] | None = None
        self._cancel_events: dict[str, threading.Event] = {}

    # ------------------------------------------------------------------ trabajo
    async def process(self, job: Any, token: str, signal: Any) -> dict[str, Any]:
        job_id = str(job.id)
        try:
            # model_validate_json + strict: sin coerciones, igual de estricto que Ajv en el API.
            import json

            payload = TranscribeJob.model_validate_json(json.dumps(job.data), strict=True)
        except Exception as error:  # noqa: BLE001
            log.error("payload inválido en el trabajo %s: %s", job_id, type(error).__name__)
            failure = JobFailure("INTERNAL", f"Payload inválido: {type(error).__name__}")
            await self.repo.fail(job_id, failure.code, failure.message)
            raise Exception(failure_reason(job_id, failure)) from error
        if str(payload.jobId) != job_id:
            failure = JobFailure("INTERNAL", "El jobId del payload no coincide con el id del trabajo.")
            await self.repo.fail(job_id, failure.code, failure.message)
            raise Exception(failure_reason(job_id, failure))

        # El evento se registra ANTES del claim: el API publica la cancelación en cuanto ve el trabajo
        # RUNNING, y un mensaje que llegara entre el claim y el registro se perdería.
        cancel = threading.Event()
        self._cancel_events[job_id] = cancel
        try:
            claimed = await self.repo.claim(job_id)
        except BaseException:
            self._cancel_events.pop(job_id, None)
            raise
        if not claimed:
            self._cancel_events.pop(job_id, None)
            # Ya no estaba QUEUED: la API lo canceló mientras esperaba, o es una reentrega. No se procesa.
            log.info("trabajo %s ya no está en cola; se omite", job_id)
            failure = JobFailure("CANCELLED", "El trabajo ya no estaba pendiente.")
            raise Exception(failure_reason(job_id, failure))

        progress = Progress(self.repo, job_id, asyncio.get_running_loop(), sink=job)
        runner = asyncio.create_task(self.runner.run(payload, progress, cancel))
        aborted = asyncio.create_task(signal.wait())
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
            self._cancel_events.pop(job_id, None)

        await self.repo.complete(job_id, result)
        return result

    # --------------------------------------------------------------- cancelación
    async def _listen_for_cancellations(self, subscribed: asyncio.Event) -> None:
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
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    cancel = CancelMessage.model_validate_json(message["data"], strict=True)
                except Exception:  # noqa: BLE001 - un mensaje malformado se ignora, nunca tumba al worker
                    log.warning("mensaje de cancelación ignorado (malformado)")
                    continue
                job_id = str(cancel.jobId)
                if self._worker is not None:
                    self._worker.cancelJob(job_id, "cancelled")
                event = self._cancel_events.get(job_id)
                if event is not None:
                    event.set()
        finally:
            await pubsub.aclose()
            await client.aclose()

    # ------------------------------------------------------------------- ciclo
    def _on_failed(self, job: Any, error: Any, *_: Any) -> None:
        """BullMQ marca `failed` también los trabajos atascados (stalled), que nadie cerró en PostgreSQL."""
        job_id = str(getattr(job, "id", ""))
        if not job_id:
            return
        asyncio.get_running_loop().create_task(
            self.repo.fail(job_id, "INTERNAL", "El trabajo se interrumpió inesperadamente.")
        )

    async def start(self) -> None:
        self._worker = Worker(
            self.config.queue_name,
            self.process,
            {
                "connection": self.config.redis_connection,
                "concurrency": self.config.concurrency,
                "lockDuration": self.config.lock_duration_ms,
                # Un trabajo atascado no se reencola solo (se reharía horas de cómputo): falla y se informa.
                "maxStalledCount": 0,
            },
        )
        self._worker.on("failed", self._on_failed)
        subscribed = asyncio.Event()
        self._cancel_task = asyncio.create_task(self._listen_for_cancellations(subscribed))
        await subscribed.wait()
        log.info("worker listo (cola %s)", self.config.queue_name)

    async def stop(self) -> None:
        """Cierre ordenado: deja terminar el trabajo en curso (stop_grace_period del contenedor)."""
        if self._worker is not None:
            await self._worker.close()
        if self._cancel_task is not None:
            self._cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cancel_task
        await asyncio.to_thread(self.repo.close)
