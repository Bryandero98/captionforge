"""TranscribeRunner con limpieza de audio (cleanAudio): ffmpeg REAL, S3 y PostgreSQL reales; Whisper y el
separador son falsos. Lo que se garantiza aquí es el ORDEN (soltar Whisper -> separar -> recargar Whisper), el
respaldo al audio original y que cancelar no se confunda con un fallo de la separación."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from captionforge_contracts import TranscribeJob, TranscribeResult

from ai_worker.db import JobRepository
from ai_worker.errors import JobCancelled
from ai_worker.models import ModelProvider
from ai_worker.progress import Progress
from ai_worker.separation import SeparationFailed
from ai_worker.transcribe import TranscribeRunner

from conftest import FakeWhisper


class FakeSeparator:
    """Sustituye al subproceso de Demucs. Registra qué ocurrió y en qué orden respecto al proveedor de Whisper."""

    def __init__(self, log: list[str], models: ModelProvider | None = None, *, mode: str = "ok", cancel: threading.Event | None = None) -> None:
        self.log = log
        self.models = models
        self.mode = mode
        self.cancel = cancel
        self.calls = 0
        self.whisper_loaded_during_run: bool | None = None

    async def separate(self, source: Path, target: Path, report) -> None:  # noqa: ANN001
        self.calls += 1
        self.log.append("separate")
        if self.models is not None:
            self.whisper_loaded_during_run = self.models.loaded
        await report("downloading_separation_model", 1.0)
        await report("separating_voice", 0.5)
        if self.mode == "fail":
            raise SeparationFailed("falló a propósito")
        if self.mode == "crash":
            raise RuntimeError("error inesperado de la biblioteca")
        if self.mode == "cancel":
            assert self.cancel is not None
            self.cancel.set()
            raise SeparationFailed("fallo mientras se cancelaba")
        target.write_bytes(source.read_bytes())  # "voz aislada": un archivo distinto, con el mismo audio
        await report("separating_voice", 1.0)


def make_models(log: list[str], whisper: FakeWhisper | None = None) -> ModelProvider:
    whisper = whisper or FakeWhisper()

    def loader(size: str) -> tuple[object, str]:
        log.append("load")
        return whisper, "cpu"

    provider = ModelProvider(loader=loader, is_cached=lambda size: True)
    provider.whisper = whisper  # type: ignore[attr-defined]
    return provider


def run_job(config, storage, models, separator, payload, *, cancel=None):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    runner = TranscribeRunner(config, storage, models, separator=separator)
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


def test_release_drops_the_loaded_model_and_the_next_get_reloads() -> None:
    log: list[str] = []
    models = make_models(log)
    models.get("base")
    assert models.loaded and models.loads == 1
    assert models.release() is True
    assert not models.loaded
    models.get("base")
    assert models.loads == 2
    assert models.release() is True and models.release() is False  # sin nada cargado no hay nada que soltar


def test_cleaning_releases_whisper_before_separating_and_transcribes_the_cleaned_audio(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    models.get("base")  # Whisper queda residente de un trabajo anterior, como en producción
    log.clear()
    separator = FakeSeparator(log, models)
    job_id, payload = new_job(options={"cleanAudio": True})
    result = run_job(config, storage, models, separator, payload)

    # El orden es la garantía de VRAM: nunca conviven los dos modelos.
    assert log == ["separate", "load"]
    assert separator.whisper_loaded_during_run is False
    TranscribeResult.model_validate_json(json.dumps(result), strict=True)
    assert result["audioCleaned"] is True and result["segmentCount"] == 3
    assert [Path(p).name for p in models.whisper.paths] == ["vocals.wav"]  # type: ignore[attr-defined]
    assert not (config.work_dir / job_id).exists()


def test_a_failing_separator_falls_back_to_the_original_audio(config, storage, new_job) -> None:  # noqa: ANN001
    for mode in ("fail", "crash"):
        log: list[str] = []
        models = make_models(log)
        separator = FakeSeparator(log, models, mode=mode)
        _, payload = new_job(options={"cleanAudio": True})
        result = run_job(config, storage, models, separator, payload)
        assert result["audioCleaned"] is False, mode
        assert result["segmentCount"] == 3, mode
        assert [Path(p).name for p in models.whisper.paths] == ["audio.wav"], mode  # type: ignore[attr-defined]


def test_the_fallback_is_announced_in_the_progress_message(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    _, payload = new_job(options={"cleanAudio": True})
    messages: list[str] = []
    original = JobRepository.report

    async def spy(self, jid, stage, percent, message):  # noqa: ANN001
        messages.append(message)
        return await original(self, jid, stage, percent, message)

    JobRepository.report = spy  # type: ignore[method-assign]
    try:
        run_job(config, storage, models, FakeSeparator(log, models, mode="fail"), payload)
    finally:
        JobRepository.report = original  # type: ignore[method-assign]
    assert any("original" in m for m in messages), messages


def test_without_the_option_the_separator_is_never_used_and_whisper_stays_resident(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    separator = FakeSeparator(log, models)
    results = []
    for _ in range(2):
        _, payload = new_job()
        results.append(run_job(config, storage, models, separator, payload))
    assert separator.calls == 0 and models.loads == 1
    assert all(r["audioCleaned"] is False for r in results)
    assert [Path(p).name for p in models.whisper.paths] == ["audio.wav", "audio.wav"]  # type: ignore[attr-defined]


def test_cancelling_during_separation_cancels_the_job_instead_of_falling_back(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    cancel = threading.Event()
    separator = FakeSeparator(log, models, mode="cancel", cancel=cancel)
    _, payload = new_job(options={"cleanAudio": True})
    with pytest.raises(JobCancelled):
        run_job(config, storage, models, separator, payload, cancel=cancel)
    assert models.whisper.calls == 0  # type: ignore[attr-defined]


def test_progress_with_cleaning_is_monotonic_and_uses_the_separation_stages(config, storage, new_job, api_db) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    job_id, payload = new_job(options={"cleanAudio": True})
    seen: list[tuple[str, float]] = []
    original = JobRepository.report

    async def spy(self, jid, stage, percent, message):  # noqa: ANN001
        seen.append((stage, percent))
        return await original(self, jid, stage, percent, message)

    JobRepository.report = spy  # type: ignore[method-assign]
    try:
        run_job(config, storage, models, FakeSeparator(log, models), payload)
    finally:
        JobRepository.report = original  # type: ignore[method-assign]
    stages = [s for s, _ in seen]
    assert "separating_voice" in stages and "downloading_separation_model" in stages
    assert stages.index("separating_voice") < stages.index("transcribing")
    percents = [p for _, p in seen]
    assert percents == sorted(percents), "el progreso retrocedió"
