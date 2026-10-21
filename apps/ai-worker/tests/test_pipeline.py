"""TranscribeRunner con ffmpeg REAL y S3 / PostgreSQL reales; Whisper simulado."""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from pathlib import Path

import pytest
from captionforge_contracts import TranscribeJob, TranscribeResult

from ai_worker.db import JobRepository
from ai_worker.errors import JobCancelled, JobFailure, classify
from ai_worker.models import ModelProvider
from ai_worker.progress import Progress
from ai_worker.storage import ObjectNotFound
from ai_worker.transcribe import TranscribeRunner

from conftest import FakeWhisper, job_row


def run_job(config, storage, models, payload, api_db=None, *, cancel=None):  # noqa: ANN001
    """Ejecuta el pipeline como lo hace el worker (claim -> run) y devuelve (resultado, repo)."""
    repo = JobRepository(config.database_url)
    runner = TranscribeRunner(config, storage, models)
    model = TranscribeJob.model_validate_json(json.dumps(payload), strict=True)
    cancel = cancel or threading.Event()

    async def go():
        assert await repo.claim(payload["jobId"])
        progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0)
        return await runner.run(model, progress, cancel)

    try:
        return asyncio.run(go())
    finally:
        repo.close()


def read_object(storage, key: str) -> bytes:  # noqa: ANN001
    import io

    buffer = io.BytesIO()
    storage._client.download_fileobj(storage.bucket, key, buffer)
    return buffer.getvalue()


def test_happy_path_produces_contract_valid_result_and_artifacts(config, storage, fake_models, new_job, api_db) -> None:  # noqa: ANN001
    job_id, payload = new_job(options={"sourceLanguage": "es"})
    result = run_job(config, storage, fake_models, payload)

    TranscribeResult.model_validate_json(json.dumps(result), strict=True)
    assert result["jobId"] == job_id and result["detectedLanguage"] == "es" and result["segmentCount"] == 3
    prefix = payload["outputPrefix"]
    assert result["artifacts"]["srt"] == f"{prefix}output.srt"

    srt = read_object(storage, result["artifacts"]["srt"]).decode()
    assert "Hola 0" in srt and "-->" in srt
    segments = json.loads(read_object(storage, result["artifacts"]["segments"]["objectKey"]))
    assert [s["text"].strip() for s in segments] == ["Hola 0", "Hola 1", "Hola 2"]
    waveform = json.loads(read_object(storage, result["artifacts"]["waveform"]))
    assert waveform["peaks"] and waveform["duration"] > 0
    # El ETag del contrato es el que S3 reporta ahora (el API lo usa para detectar cambios).
    assert result["artifacts"]["segments"]["etag"] == storage.etag(storage.bucket, result["artifacts"]["segments"]["objectKey"])
    assert re.fullmatch(r"[0-9a-f]{32}(-[0-9]+)?", result["artifacts"]["segments"]["etag"])


def test_progress_is_written_monotonic_and_workdir_is_cleaned(config, storage, fake_models, new_job, api_db) -> None:  # noqa: ANN001
    job_id, payload = new_job()
    seen: list[float] = []
    original = JobRepository.report

    async def spy(self, jid, stage, percent, message):  # noqa: ANN001
        seen.append(percent)
        return await original(self, jid, stage, percent, message)

    JobRepository.report = spy  # type: ignore[method-assign]
    try:
        run_job(config, storage, fake_models, payload)
    finally:
        JobRepository.report = original  # type: ignore[method-assign]
    assert len(seen) >= 6 and seen == sorted(seen) and seen[-1] <= 99
    assert not (Path(config.work_dir) / job_id).exists(), "el video descargado no debe quedar en disco"
    row = job_row(api_db, job_id)
    assert row["status"] == "RUNNING" and row["stage"] == "uploading"  # cerrarlo (COMPLETED) lo hace el worker


def test_model_is_loaded_once_across_jobs(config, storage, fake_models, new_job) -> None:  # noqa: ANN001
    for _ in range(3):
        run_job(config, storage, fake_models, new_job()[1])
    assert fake_models.loads == 1 and fake_models.whisper.calls == 3


def test_changing_model_size_reloads_only_when_needed(config, storage, new_job) -> None:  # noqa: ANN001
    models = ModelProvider(loader=lambda size: (FakeWhisper(), "cpu"), is_cached=lambda s: True)
    for size in ("base", "base", "small", "small", "base"):
        run_job(config, storage, models, new_job(options={"modelSize": size})[1])
    assert models.loads == 3


def test_missing_input_maps_to_input_not_found(config, storage, fake_models, new_job) -> None:  # noqa: ANN001
    _, payload = new_job(upload_input=False)
    with pytest.raises(ObjectNotFound) as caught:
        run_job(config, storage, fake_models, payload)
    assert classify(caught.value).code == "INPUT_NOT_FOUND"
    assert not any(Path(config.work_dir).glob(f"{payload['jobId']}*"))


def test_a_corrupt_video_maps_to_ffmpeg_failed_without_leaking_paths(config, storage, fake_models, new_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload = new_job(upload_input=False)
    junk = tmp_path / "basura.mp4"
    junk.write_bytes(b"esto no es un video" * 100)
    storage.upload_file(junk, payload["input"]["objectKey"], "video/mp4")
    with pytest.raises(Exception) as caught:  # noqa: PT011
        run_job(config, storage, fake_models, payload)
    failure = classify(caught.value)
    assert failure.code == "FFMPEG_FAILED"
    assert str(tmp_path) not in failure.message and "basura" not in failure.message


def test_model_download_failure_maps_to_its_code(config, storage, new_job) -> None:  # noqa: ANN001
    def boom(size, on_progress):  # noqa: ANN001
        raise ConnectionError("sin red")

    models = ModelProvider(loader=lambda s: (FakeWhisper(), "cpu"), is_cached=lambda s: False, fits=lambda s: None, download=boom)
    with pytest.raises(JobFailure) as caught:
        run_job(config, storage, models, new_job()[1])
    assert caught.value.code == "MODEL_DOWNLOAD_FAILED"


def test_cancel_between_segments_aborts_and_cleans_up(config, storage, new_job) -> None:  # noqa: ANN001
    models = ModelProvider(loader=lambda s: (FakeWhisper(delay=0.5, segments=40), "cpu"), is_cached=lambda s: True)
    job_id, payload = new_job()
    cancel = threading.Event()
    threading.Timer(2.5, cancel.set).start()
    started = time.monotonic()
    with pytest.raises(JobCancelled):
        run_job(config, storage, models, payload, cancel=cancel)
    assert time.monotonic() - started < 10, "debe abortar entre segmentos, no esperar los 20 s del trabajo"
    assert not (Path(config.work_dir) / job_id).exists()


def test_translation_is_skipped_when_source_equals_target(config, storage, fake_models, new_job) -> None:  # noqa: ANN001
    _, payload = new_job(options={"sourceLanguage": "es", "translateTo": "es"})
    result = run_job(config, storage, fake_models, payload)
    assert result["detectedLanguage"] == "es"
