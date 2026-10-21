"""Consumidor Python del smoke test: valida el contrato de extremo a extremo con BullMQ real.

NO es el worker de producción (no usa Whisper ni ffmpeg). Es la prueba de que:
  * un trabajo encolado desde Node (bullmq) lo recibe un Worker de Python (bullmq en PyPI);
  * el payload se valida con los modelos Pydantic ESTRICTOS generados del contrato;
  * progreso, resultado y error estructurado viajan en los formatos del contrato;
  * la cancelación por Redis pub/sub (canal captionforge:cancel) aborta el trabajo en curso;
  * el trabajo pesado se ejecuta fuera del bucle de eventos y el candado se renueva (sin "stalled").

El escenario lo elige `input.originalFilename` (solo en este arnés de pruebas).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time

import redis.asyncio as aioredis
from bullmq import Worker

from captionforge_contracts import CancelMessage, JobError, JobProgress, TranscribeJob, TranscribeResult

# Nombres por entorno: el smoke usa una cola y un canal únicos por ejecución para no competir con
# un worker de desarrollo ni borrar trabajos reales.
QUEUE_NAME = os.environ.get("SMOKE_QUEUE", "captionforge.transcribe")
CANCEL_CHANNEL = os.environ.get("SMOKE_CANCEL_CHANNEL", "captionforge:cancel")
NIL_UUID = "00000000-0000-4000-8000-000000000000"

REDIS = {
    "host": os.environ.get("REDIS_HOST", "127.0.0.1"),
    "port": int(os.environ.get("REDIS_PORT", "6379")),
    "password": os.environ["REDIS_PASSWORD"],
}
LOCK_DURATION_MS = int(os.environ.get("SMOKE_LOCK_DURATION_MS", "3000"))


UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


class JobFailure(Exception):
    """Fallo con código del contrato; el mensaje de la excepción es el JobError serializado."""

    def __init__(self, job_id: str, code: str, message: str) -> None:
        # Un productor que no sea Node podría encolar un id que no es UUID: el error igualmente
        # debe cumplir el contrato.
        if not UUID_RE.fullmatch(job_id):
            job_id = NIL_UUID
        error = JobError.model_validate(
            {"schemaVersion": 1, "jobId": job_id, "errorCode": code, "message": message}
        )
        super().__init__(error.model_dump_json())


async def report(job, stage: str, percent: float, message: str) -> None:
    progress = JobProgress.model_validate(
        {"schemaVersion": 1, "stage": stage, "percent": percent, "message": message}
    )
    await job.updateProgress(progress.model_dump(mode="json"))


def build_result(payload: TranscribeJob) -> dict:
    job_id = str(payload.jobId)
    prefix = payload.outputPrefix
    result = TranscribeResult.model_validate(
        {
            "schemaVersion": 1,
            "jobId": job_id,
            "detectedLanguage": "es",
            "device": "cpu",
            "durationSeconds": 12.5,
            "segmentCount": 3,
            "artifacts": {
                "srt": f"{prefix}output.srt",
                "segments": {
                    "bucket": payload.input.bucket,
                    "objectKey": f"{prefix}segments.json",
                    "etag": "9b2cf535f27731c974343645a3985328",
                },
                "waveform": f"{prefix}waveform.json",
            },
        }
    )
    return result.model_dump(mode="json")


async def process(job, token, signal):
    raw = json.dumps(job.data)
    try:
        # model_validate_json + strict=True: sin coerciones; igual de estricto que Ajv en Node.
        payload = TranscribeJob.model_validate_json(raw, strict=True)
    except Exception as exc:  # contrato roto: el productor no debió encolarlo
        raise JobFailure(str(job.id), "INTERNAL", f"Payload inválido: {type(exc).__name__}") from exc

    job_id = str(payload.jobId)
    if job_id != str(job.id):
        raise JobFailure(job_id, "INTERNAL", "El jobId del payload no coincide con el id del trabajo.")
    scenario = payload.input.originalFilename

    if scenario == "smoke-fail.mp4":
        raise JobFailure(job_id, "FFMPEG_FAILED", "ffmpeg terminó con error (simulado).")

    if scenario == "smoke-slow.mp4":
        # Trabajo largo y cooperativo: revisa la señal de aborto en cada paso.
        await report(job, "transcribing", 1.0, "Empezando")
        for step in range(150):  # hasta ~30 s si nadie cancela
            if signal.aborted:
                raise JobFailure(job_id, "CANCELLED", "Cancelado por el usuario.")
            await asyncio.sleep(0.2)
        return build_result(payload)

    if scenario == "smoke-offloop.mp4":
        # Bloqueo real de CPU (time.sleep) FUERA del bucle de eventos, durante ~3x lockDuration:
        # si el bucle estuviera bloqueado, el candado no se renovaría y BullMQ lo marcaría stalled.
        await report(job, "transcribing", 10.0, "Trabajo pesado en un hilo")
        if os.environ.get("SMOKE_BLOCK_EVENT_LOOP"):
            # Solo para la prueba negativa: demuestra que el escenario SÍ detecta un bucle bloqueado.
            time.sleep(LOCK_DURATION_MS / 1000 * 3)
        else:
            await asyncio.to_thread(time.sleep, LOCK_DURATION_MS / 1000 * 3)
        await report(job, "transcribing", 100.0, "Terminado")
        return build_result(payload)

    # Escenario por defecto: camino feliz con varias etapas de progreso.
    for stage, percent in (("downloading_input", 5.0), ("extracting_audio", 20.0),
                           ("transcribing", 60.0), ("uploading", 95.0)):
        await report(job, stage, percent, f"{stage} ({percent:.0f}%)")
        await asyncio.sleep(0.15)
    return build_result(payload)


async def listen_for_cancellations(worker: Worker, subscribed: asyncio.Event) -> None:
    client = aioredis.Redis(**REDIS, decode_responses=True)
    pubsub = client.pubsub()
    try:
        await pubsub.subscribe(CANCEL_CHANNEL)
        subscribed.set()
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            try:
                cancel = CancelMessage.model_validate_json(message["data"], strict=True)
            except Exception as exc:  # mensaje malformado: se ignora, nunca tumba al worker
                print(f"CANCEL_IGNORED {type(exc).__name__}", flush=True)
                continue
            found = worker.cancelJob(str(cancel.jobId), "cancelled")
            print(f"CANCEL_RECEIVED {cancel.jobId} tracked={found}", flush=True)
    finally:
        await pubsub.aclose()
        await client.aclose()


async def main() -> None:
    worker = Worker(
        QUEUE_NAME,
        process,
        {
            "connection": REDIS,
            "concurrency": 1,
            "lockDuration": LOCK_DURATION_MS,
            "stalledInterval": 1000,
            "maxStalledCount": 0,
        },
    )
    worker.on("stalled", lambda job_id, prev: print(f"STALLED {job_id}", flush=True))
    subscribed = asyncio.Event()
    cancel_task = asyncio.create_task(listen_for_cancellations(worker, subscribed))
    await subscribed.wait()  # READY solo cuando ya se escuchan cancelaciones
    print("WORKER_READY", flush=True)
    try:
        await cancel_task
    finally:
        await worker.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
