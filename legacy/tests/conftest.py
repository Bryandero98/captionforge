import pytest


@pytest.fixture(autouse=True)
def _isolate_ffmpeg_env(monkeypatch):
    """A developer's own CAPTIONFORGE_FFMPEG / IMAGEIO_FFMPEG_EXE must never change which ffmpeg runs."""
    monkeypatch.delenv("CAPTIONFORGE_FFMPEG", raising=False)
    monkeypatch.delenv("IMAGEIO_FFMPEG_EXE", raising=False)
