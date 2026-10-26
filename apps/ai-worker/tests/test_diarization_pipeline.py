"""TranscribeRunner con identificación de hablantes (options.diarize): ffmpeg REAL, S3 y PostgreSQL reales; Whisper y el
diarizador son falsos. Se garantiza el ORDEN (Whisper transcribe -> se suelta -> se identifica a los hablantes), el
respaldo a la transcripción normal con diarized:false y que cancelar no se confunda con un fallo."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from captionforge_contracts import TranscribeJob, TranscribeResult

from ai_worker.db import JobRepository
from ai_worker.diarization import DiarizationFailed, DiarizationUnavailable, Turn
from ai_worker.errors import JobCancelled
from ai_worker.models import ModelProvider
from ai_worker.progress import Progress
from ai_worker.transcribe import TranscribeRunner

from conftest import FakeWhisper


class FakeDiarizer:
    def __init__(self, log: list[str], models: ModelProvider | None = None, *, mode: str = "ok", cancel: threading.Event | None = None) -> None:
        self.log = log
        self.models = models
        self.mode = mode
        self.cancel = cancel
        self.calls = 0
        self.whisper_loaded_during_run: bool | None = None
        self.audio_seen: str | None = None

    async def diarize(self, audio: Path, report) -> list[Turn]:  # noqa: ANN001
        self.calls += 1
        self.log.append("diarize")
        self.audio_seen = audio.name
        if self.models is not None:
            self.whisper_loaded_during_run = self.models.loaded
        await report("downloading_diarization_model", 1.0)
        await report("diarizing", 0.5)
        if self.mode == "unavailable":
            raise DiarizationUnavailable("sin token")
        if self.mode == "fail":
            raise DiarizationFailed("falló a propósito")
        if self.mode == "crash":
            raise RuntimeError("error inesperado de la biblioteca")
        if self.mode == "cancel":
            assert self.cancel is not None
            self.cancel.set()
            raise DiarizationFailed("fallo mientras se cancelaba")
        await report("diarizing", 1.0)
        if self.mode == "empty":
            return []  # pyannote no detectó ninguna voz
        # FakeWhisper da 3 segmentos de 2,5 s cada 3 s: el primero y el tercero para uno, el segundo para otro.
        return [Turn(0.0, 2.9, "S_A"), Turn(2.9, 5.9, "S_B"), Turn(5.9, 9.0, "S_A")]


def make_models(log: list[str]) -> ModelProvider:
    whisper = FakeWhisper()

    def loader(size: str) -> tuple[object, str]:
        log.append("load")
        return whisper, "cpu"

    provider = ModelProvider(loader=loader, is_cached=lambda size: True)
    provider.whisper = whisper  # type: ignore[attr-defined]
    return provider


def run_job(config, storage, models, diarizer, payload, *, cancel=None):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    runner = TranscribeRunner(config, storage, models, diarizer=diarizer)
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


def stored_segments(storage, config, result, tmp_path: Path) -> list[dict]:  # noqa: ANN001
    target = tmp_path / "segments.json"
    storage.download(result["artifacts"]["segments"]["bucket"], result["artifacts"]["segments"]["objectKey"], target)
    return json.loads(target.read_text(encoding="utf-8"))


def test_whisper_transcribes_first_then_is_released_and_the_speakers_are_assigned(config, storage, new_job, tmp_path) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    diarizer = FakeDiarizer(log, models)
    _, payload = new_job(options={"diarize": True})
    result = run_job(config, storage, models, diarizer, payload)

    assert log == ["load", "diarize"]  # Whisper cargó, transcribió y se soltó antes del diarizador
    assert diarizer.whisper_loaded_during_run is False
    assert diarizer.audio_seen == "audio.wav"
    TranscribeResult.model_validate_json(json.dumps(result), strict=True)
    assert result["diarized"] is True and result["segmentCount"] == 3
    speakers = [s["speaker"] for s in stored_segments(storage, config, result, tmp_path)]
    assert speakers == ["SPEAKER_01", "SPEAKER_02", "SPEAKER_01"]


def test_failures_fall_back_to_the_plain_transcription(config, storage, new_job, tmp_path) -> None:  # noqa: ANN001
    for mode in ("unavailable", "fail", "crash"):
        log: list[str] = []
        models = make_models(log)
        _, payload = new_job(options={"diarize": True})
        result = run_job(config, storage, models, FakeDiarizer(log, models, mode=mode), payload)
        assert result["diarized"] is False and result["segmentCount"] == 3, mode
        assert all("speaker" not in s for s in stored_segments(storage, config, result, tmp_path)), mode


def test_a_diarization_that_finds_no_voice_is_not_reported_as_identified(config, storage, new_job, tmp_path) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    _, payload = new_job(options={"diarize": True})
    result = run_job(config, storage, models, FakeDiarizer(log, models, mode="empty"), payload)
    assert result["diarized"] is False and result["segmentCount"] == 3
    assert all("speaker" not in s for s in stored_segments(storage, config, result, tmp_path))


def test_the_fallback_is_announced_in_the_progress_message(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    _, payload = new_job(options={"diarize": True})
    messages: list[str] = []
    original = JobRepository.report

    async def spy(self, jid, stage, percent, message):  # noqa: ANN001
        messages.append(message)
        return await original(self, jid, stage, percent, message)

    JobRepository.report = spy  # type: ignore[method-assign]
    try:
        run_job(config, storage, models, FakeDiarizer(log, models, mode="fail"), payload)
    finally:
        JobRepository.report = original  # type: ignore[method-assign]
    assert any("quién habla" in m for m in messages), messages


def test_without_the_option_the_diarizer_is_never_used_and_whisper_stays_resident(config, storage, new_job, tmp_path) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    diarizer = FakeDiarizer(log, models)
    results = []
    for _ in range(2):
        _, payload = new_job()
        results.append(run_job(config, storage, models, diarizer, payload))
    assert diarizer.calls == 0 and models.loads == 1
    assert all(r["diarized"] is False for r in results)
    assert all("speaker" not in s for s in stored_segments(storage, config, results[0], tmp_path))


def test_cancelling_during_diarization_cancels_the_job_instead_of_falling_back(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    cancel = threading.Event()
    diarizer = FakeDiarizer(log, models, mode="cancel", cancel=cancel)
    _, payload = new_job(options={"diarize": True})
    with pytest.raises(JobCancelled):
        run_job(config, storage, models, diarizer, payload, cancel=cancel)


def test_cleaning_and_diarizing_together_run_in_order_and_progress_is_monotonic(config, storage, new_job) -> None:  # noqa: ANN001
    from test_separation_pipeline import FakeSeparator

    log: list[str] = []
    models = make_models(log)
    separator = FakeSeparator(log, models)
    diarizer = FakeDiarizer(log, models)
    _, payload = new_job(options={"cleanAudio": True, "diarize": True})
    seen: list[tuple[str, float]] = []
    original = JobRepository.report

    async def spy(self, jid, stage, percent, message):  # noqa: ANN001
        seen.append((stage, percent))
        return await original(self, jid, stage, percent, message)

    JobRepository.report = spy  # type: ignore[method-assign]
    try:
        repo = JobRepository(config.database_url)
        runner = TranscribeRunner(config, storage, models, separator=separator, diarizer=diarizer)
        model = TranscribeJob.model_validate_json(json.dumps(payload), strict=True)

        async def go():
            assert await repo.claim(payload["jobId"])
            progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0)
            return await runner.run(model, progress, threading.Event())

        result = asyncio.run(go())
        repo.close()
    finally:
        JobRepository.report = original  # type: ignore[method-assign]

    assert log == ["separate", "load", "diarize"]
    assert result["audioCleaned"] is True and result["diarized"] is True
    stages = [s for s, _ in seen]
    assert stages.index("separating_voice") < stages.index("transcribing") < stages.index("diarizing") < stages.index("uploading")
    percents = [p for _, p in seen]
    assert percents == sorted(percents), "el progreso retrocedió"


def test_progress_with_diarization_uses_its_stages_and_never_goes_back(config, storage, new_job) -> None:  # noqa: ANN001
    log: list[str] = []
    models = make_models(log)
    _, payload = new_job(options={"diarize": True})
    seen: list[tuple[str, float]] = []
    original = JobRepository.report

    async def spy(self, jid, stage, percent, message):  # noqa: ANN001
        seen.append((stage, percent))
        return await original(self, jid, stage, percent, message)

    JobRepository.report = spy  # type: ignore[method-assign]
    try:
        run_job(config, storage, models, FakeDiarizer(log, models), payload)
    finally:
        JobRepository.report = original  # type: ignore[method-assign]
    stages = [s for s, _ in seen]
    assert "diarizing" in stages and "downloading_diarization_model" in stages
    assert stages.index("transcribing") < stages.index("diarizing")
    percents = [p for _, p in seen]
    assert percents == sorted(percents), "el progreso retrocedió"
