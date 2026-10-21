"""Pruebas sin infraestructura: configuración, clasificación de errores y progreso."""

from __future__ import annotations

import asyncio
import errno

import pytest
from captionforge.pipeline import FfmpegTimeoutError
from captionforge.waveform import WaveformExtractionError
from captionforge_contracts import JobError

from ai_worker.config import ConfigError, WorkerConfig
from ai_worker.errors import JobFailure, classify
from ai_worker.progress import Progress
from ai_worker.storage import ObjectNotFound
from ai_worker.worker import failure_reason

BASE = {
    "REDIS_HOST": "redis",
    "REDIS_PASSWORD": "s",
    "DATABASE_URL": "postgresql://u:p@h/db",
    "S3_ENDPOINT": "http://s3:9000",
    "S3_BUCKET": "b",
    "S3_ACCESS_KEY": "a",
    "S3_SECRET_KEY": "k",
}


class TestConfig:
    def test_defaults(self) -> None:
        config = WorkerConfig.from_env(BASE)
        assert config.concurrency == 1
        assert config.queue_name == "captionforge.transcribe"
        assert config.ffmpeg_total_timeout == 6 * 3600

    @pytest.mark.parametrize("name", list(BASE))
    def test_missing_variable_fails_at_startup(self, name: str) -> None:
        env = {k: v for k, v in BASE.items() if k != name}
        with pytest.raises(ConfigError, match=name):
            WorkerConfig.from_env(env)

    @pytest.mark.parametrize("value", ["abc", "0", "-1"])
    def test_invalid_numbers_are_rejected(self, value: str) -> None:
        with pytest.raises(ConfigError):
            WorkerConfig.from_env({**BASE, "FFMPEG_STALL_TIMEOUT_SECONDS": value})

    def test_timeouts_come_from_environment(self) -> None:
        config = WorkerConfig.from_env({**BASE, "FFMPEG_STALL_TIMEOUT_SECONDS": "12", "FFMPEG_TOTAL_TIMEOUT_SECONDS": "34"})
        assert (config.ffmpeg_stall_timeout, config.ffmpeg_total_timeout) == (12.0, 34.0)


class TestClassify:
    @pytest.mark.parametrize(
        ("error", "code"),
        [
            (FfmpegTimeoutError("t"), "FFMPEG_TIMEOUT"),
            (ObjectNotFound("b/k"), "INPUT_NOT_FOUND"),
            (OSError(errno.ENOSPC, "No space left on device"), "OUT_OF_DISK"),
            (WaveformExtractionError("x"), "FFMPEG_FAILED"),
            (RuntimeError("ffmpeg fallo (codigo 1): C:\\secreto\\ruta"), "FFMPEG_FAILED"),
            (ValueError("algo raro"), "INTERNAL"),
            (JobFailure("MODEL_DOWNLOAD_FAILED", "m"), "MODEL_DOWNLOAD_FAILED"),
        ],
    )
    def test_maps_to_contract_codes(self, error: BaseException, code: str) -> None:
        assert classify(error).code == code

    def test_user_messages_never_leak_internal_details(self) -> None:
        for error in (RuntimeError("ffmpeg fallo: C:\\Users\\x\\secreto.mp4"), ValueError("password=hunter2")):
            message = classify(error).message
            assert "secreto" not in message and "hunter2" not in message and "C:\\" not in message

    def test_failure_reason_is_a_valid_job_error(self) -> None:
        reason = failure_reason("3f1c2a9e-6b1d-4c7e-9a52-0d8f5e3b7a10", JobFailure("FFMPEG_FAILED", "x" * 900))
        error = JobError.model_validate_json(reason, strict=True)
        assert error.errorCode.value == "FFMPEG_FAILED" and len(error.message) == 500

    def test_failure_reason_survives_a_non_uuid_job_id(self) -> None:
        JobError.model_validate_json(failure_reason("no-es-uuid", JobFailure("INTERNAL", "m")), strict=True)


class FakeRepo:
    def __init__(self) -> None:
        self.rows: list[tuple[str, float]] = []

    async def report(self, job_id: str, stage: str, percent: float, message: str | None) -> bool:
        self.rows.append((stage, percent))
        return True


class TestProgress:
    def test_overall_percent_is_monotonic_and_bounded(self) -> None:
        async def go() -> list[tuple[str, float]]:
            repo = FakeRepo()
            progress = Progress(repo, "id", asyncio.get_running_loop(), min_interval=0.0)  # type: ignore[arg-type]
            await progress.report("downloading_input", 1.0, "m")
            await progress.report("extracting_audio", 0.5, "m")
            await progress.report("transcribing", 0.5, "m")
            await progress.report("transcribing", 0.1, "m")  # retroceso: no debe bajar
            await progress.report("uploading", 5.0, "m")  # fuera de rango: se acota
            return repo.rows

        rows = asyncio.run(go())
        percents = [p for _, p in rows]
        assert percents == sorted(percents)
        assert percents[-1] == 99.0 and percents[0] == 5.0

    def test_throttles_updates_within_the_same_stage_but_not_stage_changes(self) -> None:
        async def go() -> list[tuple[str, float]]:
            repo = FakeRepo()
            progress = Progress(repo, "id", asyncio.get_running_loop(), min_interval=60.0)  # type: ignore[arg-type]
            for fraction in (0.1, 0.2, 0.3):
                await progress.report("transcribing", fraction, "m")
            await progress.report("translating", 0.0, "m")
            return repo.rows

        assert [stage for stage, _ in asyncio.run(go())] == ["transcribing", "translating"]

    def test_sink_method_exists_on_the_real_bullmq_job(self) -> None:
        """Regresión: el except genérico ocultó que `update_progress` no existe en bullmq.Job."""
        from bullmq import Job

        assert callable(getattr(Job, "updateProgress", None))

    def test_progress_is_published_to_the_sink_and_validates_against_the_contract(self) -> None:
        received: list[dict] = []

        class Sink:
            async def updateProgress(self, progress: dict) -> None:  # noqa: N802
                received.append(progress)

        async def go() -> None:
            progress = Progress(FakeRepo(), "id", asyncio.get_running_loop(), sink=Sink(), min_interval=0.0)  # type: ignore[arg-type]
            await progress.report("transcribing", 0.5, "mitad")

        asyncio.run(go())
        assert received == [{"schemaVersion": 1, "stage": "transcribing", "percent": received[0]["percent"], "message": "mitad"}]
        assert 0 < received[0]["percent"] < 99

    def test_a_failing_repository_never_breaks_the_job(self) -> None:
        class Broken:
            async def report(self, *args: object) -> bool:
                raise ConnectionError("db caída")

        async def go() -> None:
            await Progress(Broken(), "id", asyncio.get_running_loop()).report("transcribing", 0.5, "m")  # type: ignore[arg-type]

        asyncio.run(go())
