import io
import os
import time
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from captionforge.app import create_app
from captionforge.config import Settings
from captionforge.jobs import JobStatus
from captionforge.pipeline import write_segments_json
from captionforge.routes.upload import _cleanup_old_jobs
from captionforge.srt import Segment, WordTiming, segments_to_srt


@pytest.fixture
def app_client(tmp_path):
    settings = Settings(jobs_dir=tmp_path / "jobs")
    app = create_app(settings)
    # The route module imports run_transcription_job into its own namespace
    # (`from ..pipeline import run_transcription_job`), so it must be
    # patched there, not on captionforge.pipeline directly - otherwise
    # BackgroundTasks would still call the real function and try to spin up
    # a real Whisper model during a unit test. Same for run_burn_job, patched
    # where routes/results.py imports it.
    with (
        patch("captionforge.routes.upload.run_transcription_job", new_callable=AsyncMock),
        patch("captionforge.routes.results.run_burn_job", new_callable=AsyncMock) as burn_mock,
        TestClient(app) as client,
    ):
        client.burn_mock = burn_mock  # exposed for tests that assert on how burn was invoked
        yield client


def _fake_video_bytes() -> bytes:
    return b"not a real video, just bytes for upload validation"


def _create_job(app_client) -> str:
    response = app_client.post(
        "/api/jobs",
        files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
    )
    assert response.status_code == 201
    return response.json()["job_id"]


def _finish_transcription(app_client, job_id: str, segments: list[Segment]) -> None:
    """Fast-forwards a freshly-created job straight to DONE with real .srt/segments.json on disk.

    The background transcription task is mocked (see app_client fixture), so
    this does by hand exactly what pipeline.run_transcription_job would have
    done: write output.srt + segments.json at the paths the upload route
    already assigned, then walk the state machine to DONE.
    """
    store = app_client.app.state.job_store
    job = store.get(job_id)
    job.srt_path.parent.mkdir(parents=True, exist_ok=True)
    job.srt_path.write_text(segments_to_srt(segments), encoding="utf-8")
    write_segments_json(job.srt_path.parent, segments)
    store.update(job_id, srt_ready=True)
    store.transition(job_id, JobStatus.EXTRACTING_AUDIO)
    store.transition(job_id, JobStatus.TRANSCRIBING)
    store.transition(job_id, JobStatus.DONE)


class TestCreateJob:
    def test_rejects_an_unsupported_file_extension(self, app_client):
        response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.txt", io.BytesIO(_fake_video_bytes()), "text/plain")},
        )
        assert response.status_code == 400

    def test_accepts_a_supported_extension_and_returns_a_queued_job(self, app_client):
        response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        assert response.status_code == 201
        body = response.json()
        assert "job_id" in body
        assert body["status"] == "queued"

    def test_second_upload_while_a_job_is_active_returns_409(self, app_client):
        first = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        assert first.status_code == 201

        second = app_client.post(
            "/api/jobs",
            files={"file": ("clip2.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        assert second.status_code == 409

    def test_saves_the_uploaded_file_to_the_configured_jobs_dir(self, app_client, tmp_path):
        response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        job_id = response.json()["job_id"]
        saved_path = tmp_path / "jobs" / job_id / "input.mp4"
        assert saved_path.exists()
        assert saved_path.read_bytes() == _fake_video_bytes()


class TestGetJob:
    def test_returns_404_for_an_unknown_job_id(self, app_client):
        response = app_client.get("/api/jobs/does-not-exist")
        assert response.status_code == 404

    def test_returns_the_job_snapshot_after_upload(self, app_client):
        create_response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        job_id = create_response.json()["job_id"]

        get_response = app_client.get(f"/api/jobs/{job_id}")
        assert get_response.status_code == 200
        body = get_response.json()
        assert body["job_id"] == job_id
        assert body["srt_ready"] is False
        assert body["video_ready"] is False


class TestBurnJob:
    def test_burn_before_transcription_is_done_returns_409(self, app_client):
        create_response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        job_id = create_response.json()["job_id"]

        burn_response = app_client.post(f"/api/jobs/{job_id}/burn")
        assert burn_response.status_code == 409

    def test_burn_for_an_unknown_job_returns_404(self, app_client):
        response = app_client.post("/api/jobs/does-not-exist/burn")
        assert response.status_code == 404


class TestResultDownloadsBeforeReady:
    def test_srt_download_before_ready_returns_404(self, app_client):
        create_response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        job_id = create_response.json()["job_id"]

        response = app_client.get(f"/api/jobs/{job_id}/srt")
        assert response.status_code == 404

    def test_video_download_before_ready_returns_404(self, app_client):
        create_response = app_client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", io.BytesIO(_fake_video_bytes()), "video/mp4")},
        )
        job_id = create_response.json()["job_id"]

        response = app_client.get(f"/api/jobs/{job_id}/video")
        assert response.status_code == 404


class TestHealth:
    def test_health_reports_ffmpeg_availability(self, app_client):
        response = app_client.get("/api/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert isinstance(body["ffmpeg_available"], bool)


class TestSegmentsAndExports:
    def test_get_segments_returns_the_editable_list(self, app_client):
        job_id = _create_job(app_client)
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hello")])

        response = app_client.get(f"/api/jobs/{job_id}/segments")
        assert response.status_code == 200
        assert response.json() == {"segments": [{"index": 0, "start": 0.0, "end": 1.0, "text": "Hello"}]}

    def test_get_segments_before_ready_returns_404(self, app_client):
        job_id = _create_job(app_client)
        response = app_client.get(f"/api/jobs/{job_id}/segments")
        assert response.status_code == 404

    def test_put_segments_edits_text_and_rewrites_the_srt(self, app_client):
        job_id = _create_job(app_client)
        words = [WordTiming(start=0.0, end=1.0, text="Hello")]
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hello", words=words)])

        response = app_client.put(
            f"/api/jobs/{job_id}/segments", json={"segments": [{"index": 0, "text": "Hi!"}]}
        )
        assert response.status_code == 200
        assert response.json()["segments"][0]["text"] == "Hi!"

        srt_response = app_client.get(f"/api/jobs/{job_id}/srt")
        assert "Hi!" in srt_response.text
        assert "Hello" not in srt_response.text

    def test_editing_a_segments_text_drops_its_word_timings(self, app_client):
        job_id = _create_job(app_client)
        words = [WordTiming(start=0.0, end=1.0, text="Hello")]
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hello", words=words)])

        # Untouched: karaoke is available.
        assert app_client.get(f"/api/jobs/{job_id}").json()["karaoke_available"] is True

        app_client.put(f"/api/jobs/{job_id}/segments", json={"segments": [{"index": 0, "text": "Hi!"}]})

        # Edited: the word timings no longer match the new text, so karaoke drops.
        assert app_client.get(f"/api/jobs/{job_id}").json()["karaoke_available"] is False

    def test_editing_with_the_same_text_keeps_word_timings(self, app_client):
        job_id = _create_job(app_client)
        words = [WordTiming(start=0.0, end=1.0, text="Hello")]
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hello", words=words)])

        app_client.put(f"/api/jobs/{job_id}/segments", json={"segments": [{"index": 0, "text": "Hello"}]})
        assert app_client.get(f"/api/jobs/{job_id}").json()["karaoke_available"] is True

    def test_put_segments_before_ready_returns_409(self, app_client):
        job_id = _create_job(app_client)
        response = app_client.put(f"/api/jobs/{job_id}/segments", json={"segments": []})
        assert response.status_code == 409

    def test_put_segments_malformed_edit_returns_400(self, app_client):
        job_id = _create_job(app_client)
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hello")])
        response = app_client.put(
            f"/api/jobs/{job_id}/segments", json={"segments": [{"index": "not-a-number"}]}
        )
        assert response.status_code == 400

    def test_get_vtt_has_webvtt_header_and_dot_timestamps(self, app_client):
        job_id = _create_job(app_client)
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.5, text="Hello")])

        response = app_client.get(f"/api/jobs/{job_id}/vtt")
        assert response.status_code == 200
        assert response.text.startswith("WEBVTT\n\n")
        assert "00:00:00.000 --> 00:00:01.500" in response.text

    def test_get_ass_includes_karaoke_tags_when_words_available(self, app_client):
        job_id = _create_job(app_client)
        words = [WordTiming(start=0.0, end=1.0, text="Hi")]
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hi", words=words)])

        response = app_client.get(f"/api/jobs/{job_id}/ass")
        assert response.status_code == 200
        assert r"\k100" in response.text

    def test_get_ass_honors_the_style_query_param(self, app_client):
        job_id = _create_job(app_client)
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hi")])

        response = app_client.get(f"/api/jobs/{job_id}/ass", params={"style": "tiktok"})
        # ASS Style: lines are positional (Name,Fontname,Fontsize,...), not
        # key=value like force_style - tiktok's font size (30) is the value
        # right after the font name.
        assert "Style: Default,Arial,30," in response.text


class TestBurnStyleAndKaraoke:
    def test_burn_forwards_style_and_karaoke_to_the_pipeline(self, app_client):
        job_id = _create_job(app_client)
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hi")])

        response = app_client.post(f"/api/jobs/{job_id}/burn", data={"style": "youtube", "karaoke": "true"})
        assert response.status_code == 202

        app_client.burn_mock.assert_called_once()
        args = app_client.burn_mock.call_args.args
        assert args[-2] == "youtube"  # style_name
        assert args[-1] is True  # karaoke

    def test_burn_defaults_to_modern_style_and_no_karaoke(self, app_client):
        job_id = _create_job(app_client)
        _finish_transcription(app_client, job_id, [Segment(start=0.0, end=1.0, text="Hi")])

        response = app_client.post(f"/api/jobs/{job_id}/burn")
        assert response.status_code == 202

        args = app_client.burn_mock.call_args.args
        assert args[-2] == "modern"
        assert args[-1] is False


class TestHistoricalDownloads:
    """Once a NEW job starts, JobStore forgets the old one - but its files are still on disk.

    CaptionForge processes one job at a time by design (JobConflictError
    blocks a second upload while one is active), so an old job_id can only
    exist here because it already reached a terminal status - these routes'
    disk-existence fallback is safe by that same invariant.
    """

    def test_srt_download_still_works_for_a_job_that_is_no_longer_current(self, app_client):
        old_job_id = _create_job(app_client)
        _finish_transcription(app_client, old_job_id, [Segment(start=0.0, end=1.0, text="Old job")])

        new_job_id = _create_job(app_client)
        assert new_job_id != old_job_id

        response = app_client.get(f"/api/jobs/{old_job_id}/srt")
        assert response.status_code == 200
        assert "Old job" in response.text

    def test_video_download_still_works_for_a_job_that_is_no_longer_current(self, app_client, tmp_path):
        old_job_id = _create_job(app_client)
        _finish_transcription(app_client, old_job_id, [Segment(start=0.0, end=1.0, text="Old job")])
        # Simulate a completed burn: the real pipeline writes this file, mocked here.
        old_video_path = tmp_path / "jobs" / old_job_id / "captioned.mp4"
        old_video_path.write_bytes(b"fake mp4 bytes")
        app_client.app.state.job_store.update(old_job_id, video_ready=True)

        _create_job(app_client)  # a new job takes over JobStore

        response = app_client.get(f"/api/jobs/{old_job_id}/video")
        assert response.status_code == 200
        assert response.content == b"fake mp4 bytes"

    def test_a_job_id_that_never_existed_returns_404_not_current(self, app_client):
        _create_job(app_client)  # make sure the store isn't empty
        response = app_client.get(f"/api/jobs/{uuid.uuid4()}/srt")
        assert response.status_code == 404

    def test_path_traversal_in_job_id_is_rejected_before_touching_the_filesystem(self, app_client):
        _create_job(app_client)
        response = app_client.get("/api/jobs/..%2f..%2f..%2fetc%2fpasswd/srt")
        assert response.status_code == 404

    def test_editing_and_burning_an_old_job_still_fails(self, app_client):
        """History only ever offers downloads - editing/re-burning a non-current job stays unsupported."""
        old_job_id = _create_job(app_client)
        _finish_transcription(app_client, old_job_id, [Segment(start=0.0, end=1.0, text="Old job")])
        _create_job(app_client)

        assert app_client.get(f"/api/jobs/{old_job_id}/segments").status_code == 404
        assert app_client.post(f"/api/jobs/{old_job_id}/burn").status_code == 404


def _set_mtime(path, age_seconds: float) -> None:
    stamp = time.time() - age_seconds
    os.utime(path, (stamp, stamp))


class TestCleanupOldJobs:
    """Unit tests for the pure retention-cleanup helper - no HTTP, no JobStore."""

    def test_removes_a_directory_older_than_the_retention_window(self, tmp_path):
        old_job = tmp_path / "old-job"
        old_job.mkdir()
        _set_mtime(old_job, age_seconds=100)

        _cleanup_old_jobs(tmp_path, keep_job_id="current-job", max_age_seconds=10)

        assert not old_job.exists()

    def test_keeps_a_directory_within_the_retention_window(self, tmp_path):
        recent_job = tmp_path / "recent-job"
        recent_job.mkdir()

        _cleanup_old_jobs(tmp_path, keep_job_id="current-job", max_age_seconds=1000)

        assert recent_job.exists()

    def test_never_removes_the_job_being_kept_even_if_it_looks_stale(self, tmp_path):
        current = tmp_path / "current-job"
        current.mkdir()
        _set_mtime(current, age_seconds=100)

        _cleanup_old_jobs(tmp_path, keep_job_id="current-job", max_age_seconds=10)

        assert current.exists()

    def test_missing_jobs_dir_is_a_noop(self, tmp_path):
        _cleanup_old_jobs(tmp_path / "does-not-exist", keep_job_id="x", max_age_seconds=10)  # must not raise

    def test_ignores_files_directly_inside_jobs_dir(self, tmp_path):
        stray_file = tmp_path / "not-a-job-dir.txt"
        stray_file.write_text("x")
        _set_mtime(stray_file, age_seconds=100)

        _cleanup_old_jobs(tmp_path, keep_job_id="current-job", max_age_seconds=10)

        assert stray_file.exists()


class TestJobRetentionCleanupWiring:
    """Confirms the upload route actually calls the cleanup helper, not just that it exists."""

    def test_uploading_prunes_a_stale_job_directory(self, app_client, tmp_path):
        stale_dir = tmp_path / "jobs" / "stale-job-id"
        stale_dir.mkdir(parents=True)
        (stale_dir / "input.mp4").write_bytes(b"old video bytes")
        _set_mtime(stale_dir, age_seconds=Settings().job_retention_days * 86400 + 3600)

        job_id = _create_job(app_client)

        assert not stale_dir.exists()
        assert (tmp_path / "jobs" / job_id).exists()
