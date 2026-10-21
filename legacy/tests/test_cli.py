"""`captionforge serve` refuses to start without ffmpeg (clear message, exit code 1) and starts otherwise."""

from __future__ import annotations

import sys

import pytest

from captionforge import cli


def _run_serve(monkeypatch, *, ffmpeg: str | None) -> list:
    monkeypatch.setattr(sys, "argv", ["captionforge", "serve", "--no-browser"])
    monkeypatch.setattr(cli, "find_ffmpeg", lambda: ffmpeg)
    started: list = []
    monkeypatch.setattr(cli.uvicorn, "run", lambda *args, **kwargs: started.append((args, kwargs)))
    monkeypatch.setattr(cli, "create_app", lambda settings: object())
    if ffmpeg is None:
        with pytest.raises(SystemExit) as excinfo:
            cli.main()
        assert excinfo.value.code == 1
    else:
        cli.main()
    return started


def test_serve_without_ffmpeg_exits_with_code_1_and_explains_how_to_fix_it(monkeypatch, capsys):
    started = _run_serve(monkeypatch, ffmpeg=None)

    err = capsys.readouterr().err
    assert "CAPTIONFORGE_FFMPEG" in err
    assert "pip install imageio-ffmpeg" in err
    assert started == []  # the server never started


def test_serve_with_ffmpeg_starts_the_server(monkeypatch, capsys):
    started = _run_serve(monkeypatch, ffmpeg="/ruta/ffmpeg")

    assert len(started) == 1
    assert "CaptionForge escuchando en" in capsys.readouterr().out
