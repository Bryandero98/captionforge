"""BurnRunner con ffmpeg REAL y S3 / PostgreSQL reales."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from captionforge_contracts import BurnJob, BurnResult

from ai_worker.burn import BurnRunner
from ai_worker.db import JobRepository
from ai_worker.errors import JobCancelled, JobFailure, classify
from ai_worker.progress import BURN_STAGE_RANGES, Progress
from ai_worker.storage import ObjectNotFound

from conftest import sample_segments
from test_pipeline import read_object


def run_burn(config, storage, payload, *, cancel=None):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    runner = BurnRunner(config, storage)
    model = BurnJob.model_validate_json(json.dumps(payload), strict=True)
    cancel = cancel or threading.Event()

    async def go():
        assert await repo.claim(payload["jobId"])
        progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0, ranges=BURN_STAGE_RANGES)
        return await runner.run(model, progress, cancel)

    try:
        return asyncio.run(go())
    finally:
        repo.close()


def test_burns_with_a_plain_srt_and_uploads_a_playable_video(config, storage, new_burn_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_burn_job(style="youtube")
    result = run_burn(config, storage, payload)

    BurnResult.model_validate_json(json.dumps(result), strict=True)
    assert result["usedKaraoke"] is False
    assert result["artifacts"]["video"] == f"jobs/{job_id}/out/captioned.mp4"
    video = read_object(storage, result["artifacts"]["video"])
    assert len(video) > 1000 and video[4:8] == b"ftyp", "debe ser un MP4 real"
    assert not (Path(config.work_dir) / job_id).exists(), "los videos no se quedan en el disco del worker"


@pytest.mark.parametrize("style", ["modern", "tiktok", "youtube", "minimal"])
def test_every_style_preset_burns(config, storage, new_burn_job, style) -> None:  # noqa: ANN001
    _, payload, _ = new_burn_job(style=style)
    assert run_burn(config, storage, payload)["artifacts"]["video"].endswith("captioned.mp4")


def test_karaoke_uses_an_ass_file_when_words_have_timings(config, storage, new_burn_job) -> None:  # noqa: ANN001
    _, payload, _ = new_burn_job(karaoke=True)
    result = run_burn(config, storage, payload)
    assert result["usedKaraoke"] is True
    assert read_object(storage, result["artifacts"]["video"])[4:8] == b"ftyp"


def test_karaoke_requested_without_word_timings_falls_back_and_says_so(config, storage, new_burn_job) -> None:  # noqa: ANN001
    # Tras traducir o editar el texto los segmentos pierden sus tiempos por palabra.
    _, payload, _ = new_burn_job(karaoke=True, segments=sample_segments(words=False))
    result = run_burn(config, storage, payload)
    assert result["usedKaraoke"] is False


def test_segments_edited_after_the_request_fail_with_segments_changed(config, storage, new_burn_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload, _ = new_burn_job()
    edited = tmp_path / "editado.json"
    edited.write_text(json.dumps(sample_segments()[:1]))
    storage.upload_file(edited, payload["segments"]["objectKey"], "application/json")  # cambia el ETag

    with pytest.raises(JobFailure) as caught:
        run_burn(config, storage, payload)
    assert caught.value.code == "SEGMENTS_CHANGED"
    assert not (Path(config.work_dir) / job_id).exists()


def test_missing_video_and_missing_segments_map_to_input_not_found(config, storage, new_burn_job) -> None:  # noqa: ANN001
    _, no_video, _ = new_burn_job(upload_video=False)
    with pytest.raises(ObjectNotFound) as caught:
        run_burn(config, storage, no_video)
    assert classify(caught.value).code == "INPUT_NOT_FOUND"

    _, no_segments, _ = new_burn_job(upload_segments=False)
    with pytest.raises(ObjectNotFound) as caught:
        run_burn(config, storage, no_segments)
    assert classify(caught.value).code == "INPUT_NOT_FOUND"


def test_corrupt_segments_file_is_an_internal_error_without_leaking_content(config, storage, new_burn_job) -> None:  # noqa: ANN001
    _, payload, _ = new_burn_job(raw_segments=b'{"esto": "no es una lista de segmentos"} secreto-xyz')
    with pytest.raises(JobFailure) as caught:
        run_burn(config, storage, payload)
    assert caught.value.code == "INTERNAL" and "secreto-xyz" not in caught.value.message


def test_cancel_stops_the_job_before_encoding(config, storage, new_burn_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_burn_job()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(JobCancelled):
        run_burn(config, storage, payload, cancel=cancel)
    assert not (Path(config.work_dir) / job_id).exists()


def _frame(video: bytes, at: float, tmp_path: Path) -> bytes:
    """Un fotograma BMP del video en el instante `at`, con el mismo ffmpeg que usa el worker."""
    import subprocess

    from captionforge.ffmpeg_locator import find_ffmpeg

    source = tmp_path / "frame-source.mp4"
    source.write_bytes(video)
    done = subprocess.run(
        [find_ffmpeg(), "-v", "error", "-ss", str(at), "-i", str(source), "-frames:v", "1", "-f", "image2pipe", "-c:v", "bmp", "-"],
        capture_output=True,
        check=True,
    )
    return done.stdout


def test_the_subtitles_are_actually_rendered_into_the_picture(config, storage, new_burn_job, tmp_path) -> None:  # noqa: ANN001
    _, with_text, _ = new_burn_job(segments=[{"start": 0.0, "end": 0.9, "text": " HOLA MUNDO", "words": None}])
    # Mismo video y misma recodificación, pero el único subtítulo cae mucho después del fotograma.
    _, without_text, _ = new_burn_job(segments=[{"start": 500.0, "end": 501.0, "text": " HOLA MUNDO", "words": None}])
    shown = read_object(storage, run_burn(config, storage, with_text)["artifacts"]["video"])
    hidden = read_object(storage, run_burn(config, storage, without_text)["artifacts"]["video"])
    assert _frame(shown, 0.3, tmp_path) != _frame(hidden, 0.3, tmp_path)
