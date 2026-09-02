import io
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from captionforge.app import create_app
from captionforge.config import Settings


@pytest.fixture
def app_client(tmp_path):
    settings = Settings(jobs_dir=tmp_path / "jobs")
    app = create_app(settings)
    # The route module imports run_transcription_job into its own namespace
    # (`from ..pipeline import run_transcription_job`), so it must be
    # patched there, not on captionforge.pipeline directly - otherwise
    # BackgroundTasks would still call the real function and try to spin up
    # a real Whisper model during a unit test.
    with (
        patch("captionforge.routes.upload.run_transcription_job", new_callable=AsyncMock),
        TestClient(app) as client,
    ):
        yield client


def _fake_video_bytes() -> bytes:
    return b"not a real video, just bytes for upload validation"


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
