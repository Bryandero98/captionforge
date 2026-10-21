"""AiWorker de punta a punta: BullMQ real (Redis), PostgreSQL, S3 y ffmpeg reales; solo Whisper simulado."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
import uuid

from bullmq import Queue
from captionforge_contracts import BurnResult, TranscribeResult

import pytest
import redis.asyncio as aioredis

from ai_worker.models import ModelProvider
from ai_worker.worker import AiWorker

from conftest import FakeWhisper, job_row

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}


def isolated(config):  # noqa: ANN001
    """Cola y canal únicos por prueba: ninguna ve los trabajos ni las cancelaciones de otra."""
    tag = uuid.uuid4().hex[:8]
    return dataclasses.replace(
        config, queue_name=f"cf.test.{tag}", burn_queue_name=f"cf.test.burn.{tag}", cancel_channel=f"cf:test:cancel:{tag}"
    )


async def wait_for(api_db, job_id: str, *, until, timeout: float = 60.0) -> dict:  # noqa: ANN001
    deadline = time.monotonic() + timeout
    row = job_row(api_db, job_id)
    while time.monotonic() < deadline:
        row = job_row(api_db, job_id)
        if until(row):
            return row
        await asyncio.sleep(0.2)
    raise AssertionError(f"tiempo agotado esperando al trabajo; último estado: {row}")


async def enqueue(config, payload: dict, data: dict | None = None, *, burn: bool = False) -> Queue:  # noqa: ANN001
    queue = Queue(config.burn_queue_name if burn else config.queue_name, {"connection": config.redis_connection})
    await queue.add("burn" if burn else "transcribe", payload if data is None else data, {"jobId": payload["jobId"], "attempts": 1})
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


@pytest.mark.parametrize(
    "tamper",
    [
        pytest.param(lambda p, jid: {**p, "outputPrefix": "jobs/11111111-1111-4111-8111-111111111111/out/"}, id="prefijo-de-otro-trabajo"),
        pytest.param(lambda p, jid: {**p, "input": {**p["input"], "bucket": "otro-bucket"}}, id="bucket-ajeno"),
    ],
)
def test_payload_that_escapes_its_job_scope_is_rejected_before_any_work(tamper, config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    """Defensa en profundidad: aunque el payload cumpla el contrato, el worker no escribe fuera de
    jobs/<su id>/out/ ni lee de otro bucket u otro árbol (si Redis se comprometiera)."""
    cfg = isolated(config)
    job_id, payload = new_job()
    broken = tamper(payload, job_id)

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
    assert "fuera del alcance" in row["errorMessage"]
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


def test_burn_job_completes_through_its_own_queue(config, new_burn_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload, _ = new_burn_job(karaoke=True)

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queue = await enqueue(cfg, payload, burn=True)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert row["status"] == "COMPLETED" and row["percent"] == 100
    BurnResult.model_validate_json(json.dumps(row["result"]), strict=True)
    assert row["result"]["usedKaraoke"] is True and row["result"]["artifacts"]["video"].endswith("/captioned.mp4")
    assert fake_models.whisper.calls == 0, "el quemado no toca el modelo"


def test_segments_changed_is_reported_to_the_user_with_its_code(config, new_burn_job, api_db, fake_models, storage, tmp_path) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload, _ = new_burn_job()
    edited = tmp_path / "otra.json"
    edited.write_text("[]")
    storage.upload_file(edited, payload["segments"]["objectKey"], "application/json")

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models)
        await worker.start()
        queue = await enqueue(cfg, payload, burn=True)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert (row["status"], row["errorCode"]) == ("FAILED", "SEGMENTS_CHANGED")


def test_a_transcription_and_a_burn_never_run_at_the_same_time(config, new_job, new_burn_job, api_db) -> None:  # noqa: ANN001
    cfg = isolated(config)
    slow = ModelProvider(loader=lambda s: (FakeWhisper(delay=0.6, segments=5), "cpu"), is_cached=lambda s: True)
    transcribe_id, transcribe_payload = new_job()
    burn_id, burn_payload, _ = new_burn_job()

    async def go() -> tuple[dict, dict]:
        worker = AiWorker(cfg, models=slow)
        await worker.start()
        queues = [await enqueue(cfg, transcribe_payload), await enqueue(cfg, burn_payload, burn=True)]
        try:
            return (
                await wait_for(api_db, transcribe_id, until=lambda r: r["status"] in TERMINAL),
                await wait_for(api_db, burn_id, until=lambda r: r["status"] in TERMINAL),
            )
        finally:
            for queue in queues:
                await queue.close()
            await worker.stop()

    transcribed, burned = asyncio.run(go())
    assert transcribed["status"] == burned["status"] == "COMPLETED"
    first, second = sorted((transcribed, burned), key=lambda r: r["startedAt"])
    assert second["startedAt"] >= first["finishedAt"], "los dos trabajos se solaparon: falta el hueco único (ADR 0006)"


def test_a_job_whose_worker_died_is_closed_instead_of_staying_running_forever(config, new_job, api_db) -> None:  # noqa: ANN001
    """Simula la caída del worker borrando el candado del trabajo en Redis: BullMQ lo detecta como
    atascado (stalled) y la fila de PostgreSQL deja de decir RUNNING."""
    cfg = dataclasses.replace(isolated(config), stalled_interval_ms=1000)
    slow = ModelProvider(loader=lambda s: (FakeWhisper(delay=0.5, segments=16), "cpu"), is_cached=lambda s: True)
    job_id, payload = new_job()

    async def go() -> dict:
        worker = AiWorker(cfg, models=slow)
        await worker.start()
        queue = await enqueue(cfg, payload)
        client = aioredis.Redis(host=cfg.redis_host, port=cfg.redis_port, password=cfg.redis_password)
        try:
            await wait_for(api_db, job_id, until=lambda r: r["stage"] == "transcribing")
            await client.delete(f"bull:{cfg.queue_name}:{job_id}:lock")  # el candado "venció"
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL, timeout=30)
        finally:
            await client.aclose()
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert (row["status"], row["errorCode"]) == ("FAILED", "INTERNAL")
    assert "interrumpi" in (row["errorMessage"] or "")


def test_heartbeat_keeps_a_silent_job_alive_and_aborts_when_the_row_was_closed(config, new_job, api_db) -> None:  # noqa: ANN001
    """Etapas como descargar 4 GiB no informan progreso; sin latido el recolector del API las cerraría a los 20 min."""
    import threading

    cfg = dataclasses.replace(isolated(config), heartbeat_seconds=0.3)
    job_id, _ = new_job(upload_input=False)

    async def go() -> tuple[bool, bool]:
        worker = AiWorker(cfg)
        assert await worker.repo.claim(job_id)
        api_db.execute("UPDATE \"Job\" SET \"updatedAt\" = now() - interval '30 minutes' WHERE id = %s", (job_id,))
        cancel = threading.Event()
        beat = asyncio.create_task(worker._heartbeat(job_id, cancel))
        await asyncio.sleep(1.0)
        refreshed = api_db.execute("SELECT now() - \"updatedAt\" < interval '1 minute' FROM \"Job\" WHERE id = %s", (job_id,)).fetchone()[0]
        assert not cancel.is_set() and not beat.done()
        # Alguien (la API, el recolector) cierra la fila: el latido lo detecta y pide abortar.
        api_db.execute("UPDATE \"Job\" SET status = 'FAILED' WHERE id = %s", (job_id,))
        await asyncio.wait_for(beat, timeout=3)
        worker.repo.close()
        return refreshed, cancel.is_set()

    assert asyncio.run(go()) == (True, True)


def test_cancellations_still_arrive_after_redis_drops_the_subscription(config, new_job, api_db) -> None:  # noqa: ANN001
    cfg = isolated(config)
    slow = ModelProvider(loader=lambda s: (FakeWhisper(delay=0.5, segments=40), "cpu"), is_cached=lambda s: True)
    job_id, payload = new_job()

    async def go() -> dict:
        worker = AiWorker(cfg, models=slow)
        await worker.start()
        queue = await enqueue(cfg, payload)
        admin = aioredis.Redis(host=cfg.redis_host, port=cfg.redis_port, password=cfg.redis_password)
        try:
            await wait_for(api_db, job_id, until=lambda r: r["stage"] == "transcribing")
            await admin.client_kill_filter(_type="pubsub")  # Redis "se cae" para los suscriptores
            await asyncio.sleep(2.5)  # el worker reconecta con espera
            await publish_cancel(cfg, job_id)
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL, timeout=20)
        finally:
            await admin.aclose()
            await queue.close()
            await worker.stop()

    assert asyncio.run(go())["status"] == "CANCELLED"
