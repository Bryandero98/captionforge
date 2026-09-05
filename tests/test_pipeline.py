"""Real, non-mocked pipeline.py tests - actual ffmpeg subprocesses, actual srt/segments.json on disk.

Whisper itself is the one thing stubbed (select_device is patched to return a
fake model) - loading a real model is slow and belongs in
scripts/smoke_test_pipeline.py, run by hand. Everything downstream of that
(ffmpeg audio extraction, ffmpeg burning, state transitions, file writes) runs
for real: unit tests that mock run_transcription_job/run_burn_job at the
route boundary (see test_api_upload.py) never actually execute this module's
own code, which is exactly how a real NameError (a dropped import) reached a
live browser check instead of `pytest` - these tests close that gap.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from captionforge.ffmpeg_utils import build_burn_subtitles_cmd
from captionforge.jobs import JobStatus, JobStore
from captionforge.pipeline import (
    _ffmpeg_error_detail,
    _run_ffmpeg,
    run_burn_job,
    run_transcription_job,
    write_segments_json,
)
from captionforge.srt import Segment, WordTiming, segments_to_srt

# The fixture's real, ffprobe-measured duration - used to drive _run_ffmpeg's
# progress-fraction math against a known total, independent of whatever
# run_burn_job derives it as (the max segment end).
FIXTURE_DURATION_SECONDS = 10.106984

FIXTURE = Path(__file__).parent / "fixtures" / "tiny_test_clip.mp4"


def _fake_whisper_result():
    """One canned segment/word, shaped like faster-whisper's real transcribe() return."""

    class FakeWord:
        def __init__(self, start, end, word):
            self.start, self.end, self.word = start, end, word

    class FakeSegment:
        def __init__(self, start, end, text, words):
            self.start, self.end, self.text, self.words = start, end, text, words

    class FakeInfo:
        duration = 1.0
        language = "es"

    segments = iter([FakeSegment(0.0, 1.0, "Hola", [FakeWord(0.0, 0.5, "Hola")])])
    return segments, FakeInfo()


class TestRunTranscriptionJobReal:
    def test_extracts_real_audio_and_writes_srt_and_segments_json(self, tmp_path):
        store = JobStore()
        job = store.create()
        srt_path = tmp_path / "output.srt"

        fake_model = MagicMock()
        fake_model.transcribe.return_value = _fake_whisper_result()

        with (
            patch("captionforge.pipeline.select_device", return_value=(fake_model, "cpu")),
            patch("captionforge.pipeline.is_model_cached", return_value=True),
        ):
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path))

        assert srt_path.exists()
        assert "Hola" in srt_path.read_text(encoding="utf-8")
        assert (tmp_path / "segments.json").exists()
        assert store.get(job.id).status == JobStatus.DONE
        assert store.get(job.id).srt_ready is True

    def test_a_not_yet_cached_model_passes_through_downloading_model_first(self, tmp_path):
        """model_size not in the local cache -> DOWNLOADING_MODEL before TRANSCRIBING.

        The status the job actually SAT ON while select_device (the call
        that would trigger a real download) was running - captured via a
        side_effect, since by the time run_transcription_job returns the
        job has already moved on to DONE.
        """
        store = JobStore()
        job = store.create()
        srt_path = tmp_path / "output.srt"

        fake_model = MagicMock()
        fake_model.transcribe.return_value = _fake_whisper_result()
        status_during_load = []

        def _capture_status_and_return(*_args, **_kwargs):
            status_during_load.append(store.get(job.id).status)
            return fake_model, "cpu"

        with (
            patch("captionforge.pipeline.select_device", side_effect=_capture_status_and_return),
            patch("captionforge.pipeline.is_model_cached", return_value=False),
            patch("captionforge.pipeline.assert_model_fits") as mock_assert_fits,
            patch("captionforge.pipeline.download_model_with_progress") as mock_download,
        ):
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path, model_size="medium"))

        mock_assert_fits.assert_called_once_with("medium")
        mock_download.assert_called_once()
        assert mock_download.call_args.args[0] == "medium"
        assert status_during_load == [JobStatus.DOWNLOADING_MODEL]
        assert store.get(job.id).status == JobStatus.DONE

    def test_download_progress_callback_updates_job_progress_and_stage_label(self, tmp_path):
        """The on_progress closure passed to download_model_with_progress is real wiring,
        not just a call that happens to occur - verified by invoking it directly (as
        snapshot_download's tqdm hook would) and checking the job it actually mutates.
        """
        store = JobStore()
        job = store.create()
        srt_path = tmp_path / "output.srt"

        fake_model = MagicMock()
        fake_model.transcribe.return_value = _fake_whisper_result()
        progress_after_callback = {}

        def _capture_callback(model_size, on_progress):
            on_progress(50, 200)
            job_now = store.get(job.id)
            progress_after_callback["progress"] = job_now.progress
            progress_after_callback["stage_label"] = job_now.stage_label

        with (
            patch("captionforge.pipeline.select_device", return_value=(fake_model, "cpu")),
            patch("captionforge.pipeline.is_model_cached", return_value=False),
            patch("captionforge.pipeline.assert_model_fits"),
            patch("captionforge.pipeline.download_model_with_progress", side_effect=_capture_callback),
        ):
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path, model_size="base"))

        assert progress_after_callback["progress"] == 0.25
        assert "25%" in progress_after_callback["stage_label"]
        assert store.get(job.id).status == JobStatus.DONE

    def test_an_undersized_disk_stops_the_job_before_select_device_runs(self, tmp_path):
        from captionforge.models import InsufficientDiskSpaceError

        store = JobStore()
        job = store.create()
        srt_path = tmp_path / "output.srt"

        with (
            patch("captionforge.pipeline.select_device") as mock_select_device,
            patch("captionforge.pipeline.is_model_cached", return_value=False),
            patch(
                "captionforge.pipeline.assert_model_fits",
                side_effect=InsufficientDiskSpaceError("no cabe"),
            ),
            contextlib.suppress(InsufficientDiskSpaceError),
        ):
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path))

        mock_select_device.assert_not_called()
        assert store.get(job.id).status == JobStatus.ERROR
        assert store.get(job.id).error == "no cabe"

    def test_a_cancel_mid_flight_does_not_clobber_the_cancellation_message(self, tmp_path):
        """Regression: cancel() moving the job to ERROR used to surface as an
        InvalidTransitionError from the NEXT store.transition() call this
        background task makes - caught by the generic `except Exception`,
        which overwrote "Cancelado por el usuario." with that confusing
        technical message and then re-raised it as an unhandled exception
        (a scary traceback dump for an outcome the user already triggered).
        """
        store = JobStore()
        job = store.create()
        srt_path = tmp_path / "output.srt"

        fake_model = MagicMock()
        fake_model.transcribe.return_value = _fake_whisper_result()

        def _cancel_then_return(*_args, **_kwargs):
            store.cancel(job.id)
            return fake_model, "cpu"

        with (
            patch("captionforge.pipeline.select_device", side_effect=_cancel_then_return),
            patch("captionforge.pipeline.is_model_cached", return_value=True),
        ):
            # Must not raise - InvalidTransitionError is swallowed, not re-thrown.
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path))

        assert store.get(job.id).status == JobStatus.ERROR
        assert store.get(job.id).error == "Cancelado por el usuario."

    def test_a_supersede_mid_flight_does_not_touch_the_new_job(self, tmp_path):
        """Same race, but the slot was reused for a brand new upload (rather
        than left cancelled) before this orphaned background task's next
        store call - which must then raise UnknownJobError (job_id no
        longer matches self._job) rather than corrupting the new job.
        """
        store = JobStore()
        job = store.create()
        srt_path = tmp_path / "output.srt"

        fake_model = MagicMock()
        fake_model.transcribe.return_value = _fake_whisper_result()
        new_job_holder = {}

        def _supersede_then_return(*_args, **_kwargs):
            store.cancel(job.id)
            new_job_holder["job"] = store.create()
            return fake_model, "cpu"

        with (
            patch("captionforge.pipeline.select_device", side_effect=_supersede_then_return),
            patch("captionforge.pipeline.is_model_cached", return_value=True),
        ):
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path))

        new_job = new_job_holder["job"]
        assert store.get(new_job.id).status == JobStatus.QUEUED
        assert store.get(new_job.id).error is None


class TestRunFfmpegProgressReal:
    def test_progress_callback_gets_increasing_values_ending_near_one(self, tmp_path):
        srt_path = tmp_path / "output.srt"
        srt_path.write_text(segments_to_srt([Segment(start=0.0, end=1.0, text="Hola")]), encoding="utf-8")
        output_path = tmp_path / "captioned.mp4"
        cmd = build_burn_subtitles_cmd(str(FIXTURE), str(srt_path), str(output_path), "modern")

        progress_values: list[float] = []
        asyncio.run(
            _run_ffmpeg(cmd, on_progress=progress_values.append, total_duration=FIXTURE_DURATION_SECONDS)
        )

        assert output_path.exists()
        assert progress_values, "expected at least one time= update while burning a 10s real video"
        assert progress_values == sorted(progress_values)
        assert progress_values[-1] > 0.9

    def test_without_on_progress_or_total_duration_still_just_waits_for_completion(self, tmp_path):
        srt_path = tmp_path / "output.srt"
        srt_path.write_text(segments_to_srt([Segment(start=0.0, end=1.0, text="Hola")]), encoding="utf-8")
        output_path = tmp_path / "captioned.mp4"
        cmd = build_burn_subtitles_cmd(str(FIXTURE), str(srt_path), str(output_path), "modern")

        asyncio.run(_run_ffmpeg(cmd))  # must not raise despite no progress callback wired up

    def test_a_real_ffmpeg_failure_raises_a_short_readable_message(self, tmp_path):
        """Regression: job.error used to be ffmpeg's ENTIRE stderr - unreadable, and long
        enough on a real encode to bury the one line that actually explains the failure.
        Points ffmpeg at a nonexistent input to force a real, non-mocked failure.
        """
        missing_input = tmp_path / "does_not_exist.mp4"
        cmd = ["ffmpeg", "-y", "-i", str(missing_input), str(tmp_path / "out.wav")]

        with pytest.raises(RuntimeError) as excinfo:
            asyncio.run(_run_ffmpeg(cmd))

        message = str(excinfo.value)
        assert message.startswith("ffmpeg fallo (codigo")
        assert len(message) < 500
        assert "No such file" in message or "system cannot find" in message.lower()


class TestFfmpegErrorDetail:
    def test_strips_repeated_frame_progress_spam(self):
        lines = [f"frame={i} fps=25 time=00:00:0{i}.00 bitrate=419kbits/s speed=1x" for i in range(20)]
        stderr = "\r".join(lines)
        assert _ffmpeg_error_detail(stderr) == ""

    def test_keeps_the_real_diagnostic_lines_at_the_end(self):
        stderr = (
            "frame=1 fps=25 time=00:00:01.00 bitrate=419kbits/s speed=1x\r"
            "frame=2 fps=25 time=00:00:02.00 bitrate=419kbits/s speed=1x\n"
            "[mp4 @ 0x1234] moov atom not found\n"
            "does_not_exist.mp4: Invalid data found when processing input\n"
        )
        detail = _ffmpeg_error_detail(stderr)
        assert "Invalid data found when processing input" in detail
        assert "frame=" not in detail

    def test_bounded_length_even_with_many_real_lines(self):
        stderr = "\n".join(f"a real diagnostic line number {i} with some words in it" for i in range(50))
        detail = _ffmpeg_error_detail(stderr, max_chars=100)
        assert len(detail) <= 100

    def test_empty_stderr_yields_empty_detail(self):
        assert _ffmpeg_error_detail("") == ""


class TestRunBurnJobReal:
    def _prep_done_job(self, tmp_path: Path, segments: list[Segment]):
        store = JobStore()
        job = store.create()
        job_dir = tmp_path / job.id
        job_dir.mkdir()
        srt_path = job_dir / "output.srt"
        output_path = job_dir / "captioned.mp4"
        srt_path.write_text(segments_to_srt(segments), encoding="utf-8")
        write_segments_json(job_dir, segments)
        store.update(job.id, srt_ready=True)
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        store.transition(job.id, JobStatus.TRANSCRIBING)
        store.transition(job.id, JobStatus.DONE)
        return store, job.id, srt_path, output_path

    def test_plain_style_burn_produces_a_real_playable_video(self, tmp_path):
        store, job_id, srt_path, output_path = self._prep_done_job(
            tmp_path, [Segment(start=0.0, end=1.0, text="Hola")]
        )

        asyncio.run(run_burn_job(store, job_id, FIXTURE, srt_path, output_path, "youtube", False))

        assert output_path.exists()
        assert output_path.stat().st_size > 0
        assert store.get(job_id).status == JobStatus.BURNED
        assert store.get(job_id).video_ready is True
        assert store.get(job_id).progress == 1.0

    def test_karaoke_burn_writes_a_real_ass_file_and_produces_a_video(self, tmp_path):
        words = [WordTiming(start=0.0, end=1.0, text="Hola")]
        store, job_id, srt_path, output_path = self._prep_done_job(
            tmp_path, [Segment(start=0.0, end=1.0, text="Hola", words=words)]
        )

        asyncio.run(run_burn_job(store, job_id, FIXTURE, srt_path, output_path, "tiktok", True))

        assert output_path.exists()
        assert output_path.stat().st_size > 0
        ass_path = srt_path.parent / "karaoke.ass"
        assert ass_path.exists()
        assert r"\k100" in ass_path.read_text(encoding="utf-8")

    def test_karaoke_requested_but_unavailable_falls_back_to_plain_style(self, tmp_path):
        # No word timings on this segment - karaoke=True has nothing to render, must not error.
        store, job_id, srt_path, output_path = self._prep_done_job(
            tmp_path, [Segment(start=0.0, end=1.0, text="Hola", words=None)]
        )

        asyncio.run(run_burn_job(store, job_id, FIXTURE, srt_path, output_path, "modern", True))

        assert output_path.exists()
        assert output_path.stat().st_size > 0
        assert not (srt_path.parent / "karaoke.ass").exists()
        assert store.get(job_id).status == JobStatus.BURNED
