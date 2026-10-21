"""ffmpeg procesa archivos que sube cualquiera: no debe heredar los secretos del proceso que lo lanza.

Se usa un Python como "ffmpeg" falso que vuelca su propio entorno a un archivo; así se comprueba lo que de
verdad recibe el hijo, en los dos sitios que lanzan ffmpeg (pipeline y waveform).
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from captionforge import ffmpeg_locator, pipeline, waveform

_DUMP_ENV = "import json, os, sys\nopen(sys.argv[1], 'w').write(json.dumps(dict(os.environ)))\n"

_SECRETS = {
    "DATABASE_URL": "postgresql://cf_worker:clave-secreta@db/captionforge",
    "S3_SECRET_KEY": "s3-secreto",
    "S3_ACCESS_KEY": "s3-acceso",
    "REDIS_PASSWORD": "redis-secreto",
    "AWS_SECRET_ACCESS_KEY": "aws-secreto",
    "API_KEY": "api-secreta",
    "HF_TOKEN": "hf-secreto",
}


@pytest.fixture
def secrets_in_environment(monkeypatch):
    for name, value in _SECRETS.items():
        monkeypatch.setenv(name, value)


def _leaked(dump: Path) -> list[str]:
    child = json.loads(dump.read_text())
    return sorted(name for name in _SECRETS if name in child)


def test_pipeline_ffmpeg_does_not_inherit_secrets(secrets_in_environment, monkeypatch, tmp_path):
    dump = tmp_path / "env.json"
    monkeypatch.setattr(pipeline, "with_ffmpeg_path", lambda cmd: cmd)

    asyncio.run(pipeline._run_ffmpeg([sys.executable, "-c", _DUMP_ENV, str(dump)]))

    assert _leaked(dump) == []


def test_waveform_ffmpeg_does_not_inherit_secrets(secrets_in_environment, monkeypatch, tmp_path):
    dump = tmp_path / "env.json"
    monkeypatch.setattr(waveform, "with_ffmpeg_path", lambda cmd: [sys.executable, "-c", _DUMP_ENV, str(dump)])

    waveform.compute_waveform_peaks(tmp_path / "video.mp4")  # el falso no emite audio; solo importa su entorno

    assert _leaked(dump) == []


class TestFfmpegEnv:
    def test_keeps_what_ffmpeg_needs_to_run(self, monkeypatch):
        monkeypatch.setenv("PATH", "/usr/bin")
        monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")
        monkeypatch.setenv("TMPDIR", "/tmp/trabajo")
        monkeypatch.setenv("FONTCONFIG_PATH", "/etc/fonts")
        monkeypatch.setenv("LANG", "C.UTF-8")

        env = ffmpeg_locator.ffmpeg_env()

        assert env["PATH"] == "/usr/bin"
        assert env["SYSTEMROOT"] == r"C:\Windows"
        assert env["TMPDIR"] == "/tmp/trabajo"
        assert env["FONTCONFIG_PATH"] == "/etc/fonts"
        assert env["LANG"] == "C.UTF-8"

    def test_drops_everything_else(self, secrets_in_environment, monkeypatch):
        monkeypatch.setenv("ALGO_RARO", "x")

        env = ffmpeg_locator.ffmpeg_env()

        assert not set(_SECRETS) & set(env)
        assert "ALGO_RARO" not in env
