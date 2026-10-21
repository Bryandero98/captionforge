"""Tests for GET /api/models/{model_size}/preflight."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from captionforge.app import create_app
from captionforge.config import Settings


@pytest.fixture
def app_client(tmp_path):
    settings = Settings(jobs_dir=tmp_path / "jobs")
    app = create_app(settings)
    with TestClient(app) as client:
        yield client


class TestModelPreflightRoute:
    def test_reports_size_and_free_disk_for_a_valid_model(self, app_client):
        with (
            patch("captionforge.models.is_model_cached", return_value=False),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": 50 * 1024**3})()),
        ):
            response = app_client.get("/api/models/small/preflight")

        assert response.status_code == 200
        body = response.json()
        assert body["model_size"] == "small"
        assert body["cached"] is False
        assert body["approx_bytes"] > 0
        assert body["free_bytes"] == 50 * 1024**3
        assert body["fits"] is True

    def test_refuses_when_disk_is_too_tight(self, app_client):
        with (
            patch("captionforge.models.is_model_cached", return_value=False),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": 1024})()),
        ):
            response = app_client.get("/api/models/medium/preflight")

        assert response.json()["fits"] is False

    def test_unknown_model_size_is_a_400_not_a_500(self, app_client):
        response = app_client.get("/api/models/gigantic/preflight")
        assert response.status_code == 400
