"""TranslateRunner (ADR 0020, T7): traduce segments.json conservando los tiempos. S3 y PostgreSQL reales; el traductor es falso."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import threading
from pathlib import Path

import pytest
from captionforge_contracts import TranslateJob, TranslateResult

from ai_worker.adapters import Adapters
from ai_worker.db import JobRepository
from ai_worker.errors import JobCancelled, JobFailure
from ai_worker.progress import TRANSLATE_STAGE_RANGES, Progress
from ai_worker.translate import TranslateRunner

from conftest import sample_segments
from test_pipeline import read_object


class FakeTranslator:
    """Traduce `Hola 1` -> `[es] Hola 1` y recuerda cada lote que recibió."""

    def __init__(self, fail_on_call: int | None = None) -> None:
        self.batches: list[list[str]] = []
        self.fail_on_call = fail_on_call

    async def translate(self, texts: list[str], source: str, target: str) -> list[str]:
        self.batches.append(list(texts))
        if self.fail_on_call is not None and len(self.batches) == self.fail_on_call:
            raise JobFailure("EXTERNAL_UNAVAILABLE", "El proveedor no responde.")
        return [f"[{target}] {text.strip()}" for text in texts]


def run_translate(config, storage, payload, *, translator=None, cancel=None, runner_config=None):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    translator = translator or FakeTranslator()
    adapters = Adapters(None, translators={payload["options"]["provider"]: translator})
    runner = TranslateRunner(runner_config or config, storage, adapters)
    model = TranslateJob.model_validate_json(json.dumps(payload), strict=True)
    cancel = cancel or threading.Event()

    async def go():
        assert await repo.claim(payload["jobId"])
        progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0, ranges=TRANSLATE_STAGE_RANGES)
        return await runner.run(model, progress, cancel)

    try:
        return asyncio.run(go())
    finally:
        repo.close()


def test_translates_the_text_and_keeps_every_time(config, storage, new_translate_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_translate_job()
    result = run_translate(config, storage, payload)

    TranslateResult.model_validate_json(json.dumps(result), strict=True)
    assert result["provider"] == "argos" and result["sourceLanguage"] == "en" and result["targetLanguage"] == "es"
    assert result["segmentCount"] == 3
    artifact = result["artifacts"]["segments"]
    assert artifact["objectKey"] == f"jobs/{job_id}/out/translated-segments.json"
    translated = json.loads(read_object(storage, artifact["objectKey"]))
    original = sample_segments()
    assert [s["text"] for s in translated] == ["[es] Hola 0", "[es] Hola 1", "[es] Hola 2"]
    assert [(s["start"], s["end"]) for s in translated] == [(o["start"], o["end"]) for o in original]
    # Los tiempos por palabra del idioma original no sirven en el traducido: se reparten por longitud (sin probabilidad).
    assert all(word["probability"] is None for s in translated for word in s["words"])
    assert artifact["etag"] == storage.etag(config.s3_bucket, artifact["objectKey"])


def test_characters_count_what_is_sent_and_blank_segments_are_not_sent(config, storage, new_translate_job) -> None:  # noqa: ANN001
    blank = {"start": 3.0, "end": 3.5, "text": "   ", "words": None}
    _, payload, _ = new_translate_job(segments=[*sample_segments(), blank])
    translator = FakeTranslator()
    result = run_translate(config, storage, payload, translator=translator)

    sent = [text for batch in translator.batches for text in batch]
    assert len(sent) == 3, "un segmento en blanco no se envía (y no se paga)"
    assert result["characters"] == sum(len(text.strip()) for text in sent)
    assert result["segmentCount"] == 4
    translated = json.loads(read_object(storage, result["artifacts"]["segments"]["objectKey"]))
    assert translated[3]["text"].strip() == ""


def test_long_jobs_are_sent_in_batches_in_order(config, storage, new_translate_job) -> None:  # noqa: ANN001
    many = [{"start": i, "end": i + 0.9, "text": f"Frase {i}", "words": None} for i in range(95)]
    _, payload, _ = new_translate_job(segments=many)
    translator = FakeTranslator()
    result = run_translate(config, storage, payload, translator=translator)
    assert len(translator.batches) > 1
    assert all(len(batch) <= 40 for batch in translator.batches)
    translated = json.loads(read_object(storage, result["artifacts"]["segments"]["objectKey"]))
    assert [s["text"] for s in translated] == [f"[es] Frase {i}" for i in range(95)]


def test_segments_edited_after_the_request_fail_with_segments_changed(config, storage, new_translate_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_translate_job()
    edited = tmp_path / "editado.json"
    edited.write_text(json.dumps(sample_segments()[:1]))
    storage.upload_file(edited, payload["segments"]["objectKey"], "application/json")
    with pytest.raises(JobFailure) as caught:
        run_translate(config, storage, payload)
    assert caught.value.code == "SEGMENTS_CHANGED"


def test_a_job_over_the_spending_caps_fails_before_calling_the_provider(config, storage, new_translate_job) -> None:  # noqa: ANN001
    translator = FakeTranslator()
    for caps in ({"max_job_segments": 2}, {"max_job_characters": 10}):
        _, payload, _ = new_translate_job()  # un trabajo nuevo por tope: el anterior ya quedó tomado
        with pytest.raises(JobFailure) as caught:
            run_translate(config, storage, payload, translator=translator, runner_config=dataclasses.replace(config, **caps))
        assert caught.value.code == "JOB_TOO_LARGE"
    assert translator.batches == [], "no se gasta nada si el trabajo ya excede el tope"


def test_a_provider_failure_is_a_controlled_failure_and_leaves_no_files(config, storage, new_translate_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_translate_job()
    with pytest.raises(JobFailure) as caught:
        run_translate(config, storage, payload, translator=FakeTranslator(fail_on_call=1))
    assert caught.value.code == "EXTERNAL_UNAVAILABLE"
    assert not (Path(config.work_dir) / job_id).exists()


def test_cancellation_between_batches_stops_the_job(config, storage, new_translate_job) -> None:  # noqa: ANN001
    many = [{"start": i, "end": i + 0.9, "text": f"Frase {i}", "words": None} for i in range(95)]
    _, payload, _ = new_translate_job(segments=many)
    cancel = threading.Event()

    class CancelsAfterFirst(FakeTranslator):
        async def translate(self, texts, source, target):  # noqa: ANN001
            cancel.set()
            return await super().translate(texts, source, target)

    translator = CancelsAfterFirst()
    with pytest.raises(JobCancelled):
        run_translate(config, storage, payload, translator=translator, cancel=cancel)
    assert len(translator.batches) == 1
