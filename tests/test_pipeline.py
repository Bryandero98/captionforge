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
from pathlib import Path
from unittest.mock import MagicMock, patch

from captionforge.jobs import JobStatus, JobStore
from captionforge.pipeline import run_burn_job, run_transcription_job, write_segments_json
from captionforge.srt import Segment, WordTiming, segments_to_srt

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

        with patch("captionforge.pipeline.select_device", return_value=(fake_model, "cpu")):
            asyncio.run(run_transcription_job(store, job.id, FIXTURE, srt_path))

        assert srt_path.exists()
        assert "Hola" in srt_path.read_text(encoding="utf-8")
        assert (tmp_path / "segments.json").exists()
        assert store.get(job.id).status == JobStatus.DONE
        assert store.get(job.id).srt_ready is True


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
