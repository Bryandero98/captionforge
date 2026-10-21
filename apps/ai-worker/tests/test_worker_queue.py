"""AiWorker de punta a punta: BullMQ real (Redis), PostgreSQL, S3 y ffmpeg reales; solo Whisper simulado."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
import uuid

from bullmq import Queue
from captionforge_contracts import TranscribeResult

import redis.asyncio as aioredis

from ai_worker.models import ModelProvider
from ai_worker.worker import AiWorker

from conftest import FakeWhisper, job_row

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}


def isolated(config):  # noqa: ANN001
    """Cola y canal únicos por prueba: ninguna ve los trabajos ni las cancelaciones de otra."""
    tag = uuid.uuid4().hex[:8]
    return dataclasses.replace(config, queue_name=f"cf.test.{tag}", cancel_channel=f"cf:test:cancel:{tag}")


async def wait_for(api_db, job_id: str, *, until, timeout: float = 60.0) -> dict:  # noqa: ANN001
    deadline = time.monotonic() + timeout
    row = job_row(api_db, job_id)
    while time.monotonic() < deadline:
        row = job_row(api_db, job_id)
        if until(row):
            return row
        await asyncio.sleep(0.2)
    raise AssertionError(f"tiempo agotado esperando al trabajo; último estado: {row}")


async def enqueue(config, payload: dict, data: dict | None = None) -> Queue:  # noqa: ANN001
    queue = Queue(config.queue_name, {"connection": config.redis_connection})
    await queue.add("transcribe", payload if data is None else data, {"jobId": payload["jobId"], "attempts": 1})
    return queue


async def publish_cancel(config, job_id: str) -> None:  # noqa: ANN001
    client = aioredis.Redis(host=config.redis_host, port=config.redis_port, password=config.redis_password)
    await client.publish(config.cancel_channel, json.dumps({"schemaVersion": 1, "jobId": job_id}))
    await client.aclose()


def test_job_completes_end_to_end(config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload = new_job()

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queue = await enqueue(cfg, payload)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert row["status"] == "COMPLETED" and row["percent"] == 100 and row["errorCode"] is None
    TranscribeResult.model_validate_json(json.dumps(row["result"]), strict=True)
    assert row["result"]["jobId"] == job_id and row["startedAt"] is not None and row["finishedAt"] is not None


def test_cancel_over_pubsub_stops_a_running_job(config, new_job, api_db) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload = new_job()
    slow = ModelProvider(loader=lambda s: (FakeWhisper(delay=0.5, segments=60), "cpu"), is_cached=lambda s: True)

    async def go() -> tuple[dict, float]:
        worker = AiWorker(cfg, models=slow)
        await worker.start()
        queue = await enqueue(cfg, payload)
        try:
            await wait_for(api_db, job_id, until=lambda r: r["stage"] == "transcribing")
            sent = time.monotonic()
            await publish_cancel(cfg, job_id)
            row = await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL, timeout=20)
            return row, time.monotonic() - sent
        finally:
            await queue.close()
            await worker.stop()

    row, elapsed = asyncio.run(go())
    assert row["status"] == "CANCELLED" and row["errorCode"] == "CANCELLED"
    assert elapsed < 10, "cancelar debe cortar el trabajo (60 segmentos x 0,5 s = 30 s), no esperar a que termine"


def test_invalid_payload_fails_without_touching_the_pipeline(config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload = new_job()
    broken = {**payload, "schemaVersion": 2}

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queue = await enqueue(cfg, payload, data=broken)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert row["status"] == "FAILED" and row["errorCode"] == "INTERNAL"
    assert fake_models.whisper.calls == 0 and fake_models.loads == 0


def test_job_cancelled_while_queued_is_skipped(config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload = new_job()
    api_db.execute("UPDATE \"Job\" SET status = 'CANCELLED' WHERE id = %s", (job_id,))

    async def go() -> None:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queue = await enqueue(cfg, payload)
        try:
            await asyncio.sleep(3)
        finally:
            await queue.close()
            await worker.stop()

    asyncio.run(go())
    assert job_row(api_db, job_id)["status"] == "CANCELLED"
    assert fake_models.whisper.calls == 0


def test_a_missing_input_is_reported_with_its_contract_code(config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload = new_job(upload_input=False)

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queue = await enqueue(cfg, payload)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert (row["status"], row["errorCode"]) == ("FAILED", "INPUT_NOT_FOUND")
    assert "jobs/" not in (row["errorMessage"] or ""), "el mensaje al usuario no debe filtrar claves internas"


def test_two_jobs_run_one_at_a_time_and_both_complete(config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    first_id, first = new_job()
    second_id, second = new_job()

    async def go() -> list[dict]:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queues = [await enqueue(cfg, first), await enqueue(cfg, second)]
        try:
            return [await wait_for(api_db, j, until=lambda r: r["status"] in TERMINAL) for j in (first_id, second_id)]
        finally:
            for queue in queues:
                await queue.close()
            await worker.stop()

    rows = asyncio.run(go())
    assert [r["status"] for r in rows] == ["COMPLETED", "COMPLETED"]
    assert fake_models.loads == 1, "el modelo se carga una vez por proceso, no por trabajo"
