"""Traducción por la cola real de BullMQ (ADR 0020, T7a) y el adaptador local de Argos."""

from __future__ import annotations

import asyncio
import json

import pytest
from bullmq import Queue
from captionforge_contracts import TranslateResult

from ai_worker import adapters as adapters_module
from ai_worker.adapters import Adapters, ArgosTranslator
from ai_worker.errors import JobFailure
from ai_worker.worker import AiWorker

from test_pipeline import read_object
from test_translate_job import FakeTranslator
from test_worker_queue import TERMINAL, isolated, wait_for


async def enqueue_translate(config, payload: dict) -> Queue:  # noqa: ANN001
    queue = Queue(config.translate_queue_name, {"connection": config.redis_connection})
    await queue.add("translate", payload, {"jobId": payload["jobId"], "attempts": 1})
    return queue


def test_translate_job_completes_through_its_own_queue(config, new_translate_job, api_db, fake_models, storage) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload, _ = new_translate_job()

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models, adapters=Adapters(None, translators={"argos": FakeTranslator()}))
        await worker.start()
        queue = await enqueue_translate(cfg, payload)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert row["status"] == "COMPLETED" and row["percent"] == 100
    TranslateResult.model_validate_json(json.dumps(row["result"]), strict=True)
    translated = json.loads(read_object(storage, row["result"]["artifacts"]["segments"]["objectKey"]))
    assert translated[0]["text"] == "[es] Hola 0"
    assert fake_models.whisper.calls == 0, "traducir no toca Whisper"


def test_a_translate_payload_aimed_at_another_jobs_output_is_rejected(config, new_translate_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload, _ = new_translate_job()
    hostile = {**payload, "outputPrefix": "jobs/00000000-0000-4000-8000-0000000000aa/out/"}

    async def go() -> dict:
        worker = AiWorker(cfg, models=fake_models, adapters=Adapters(None, translators={"argos": FakeTranslator()}))
        await worker.start()
        queue = await enqueue_translate(cfg, hostile)
        try:
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL)
        finally:
            await queue.close()
            await worker.stop()

    row = asyncio.run(go())
    assert (row["status"], row["errorCode"]) == ("FAILED", "INTERNAL")


class FakeArgosPackage:
    def translate(self, text: str) -> str:
        return f"<{text}>"


def test_argos_adapter_translates_each_text_with_the_installed_pair(monkeypatch: pytest.MonkeyPatch) -> None:
    from captionforge import translate as legacy

    asked: list[tuple[str, str]] = []
    monkeypatch.setattr(legacy, "_ensure_language_pair_installed", lambda source, target: asked.append((source, target)))
    monkeypatch.setattr(legacy, "_get_translation", lambda source, target: FakeArgosPackage())
    result = asyncio.run(ArgosTranslator().translate(["hola", "adiós"], "es", "en"))
    assert result == ["<hola>", "<adiós>"]
    assert asked == [("es", "en")]


def test_argos_adapter_without_a_loadable_model_is_an_internal_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    from captionforge import translate as legacy

    monkeypatch.setattr(legacy, "_ensure_language_pair_installed", lambda source, target: None)
    monkeypatch.setattr(legacy, "_get_translation", lambda source, target: None)
    with pytest.raises(JobFailure) as caught:
        asyncio.run(ArgosTranslator().translate(["hola"], "es", "en"))
    assert caught.value.code == "INTERNAL"


def test_adapters_refuses_an_external_provider_it_cannot_serve() -> None:
    async def go() -> None:
        async with Adapters(None).translator("openai", "j"):
            pass

    with pytest.raises(JobFailure):
        asyncio.run(go())
    assert adapters_module  # el módulo se importa sin dependencias de red
