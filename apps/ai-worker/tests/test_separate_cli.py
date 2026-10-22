"""Protocolo del hijo real (separate_cli) con un motor falso: sin torch ni demucs."""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import pytest

from ai_worker import separate_cli


def test_main_wires_progress_lines_and_returns_zero(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source, target = tmp_path / "a.wav", tmp_path / "v.wav"
    source.write_bytes(b"x")

    def engine(src: Path, dst: Path, emit) -> None:  # noqa: ANN001
        emit("downloading_separation_model", 1.0)
        emit("separating_voice", 0.25)
        dst.write_bytes(b"ok")

    assert separate_cli.main([str(source), str(target)], engine=engine) == 0
    assert capsys.readouterr().out.splitlines() == [
        "PROGRESS downloading_separation_model 1.000",
        "PROGRESS separating_voice 0.250",
    ]
    assert target.read_bytes() == b"ok"


def test_main_returns_nonzero_and_keeps_the_traceback_off_stdout(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    def engine(src: Path, dst: Path, emit) -> None:  # noqa: ANN001
        raise RuntimeError("boom")

    assert separate_cli.main([str(tmp_path / "a.wav"), str(tmp_path / "v.wav")], engine=engine) == 1
    captured = capsys.readouterr()
    assert "PROGRESS" not in captured.out and "boom" in captured.err


def test_main_rejects_wrong_usage() -> None:
    assert separate_cli.main(["solo-uno"], engine=lambda *args: None) == 2


def test_wav_roundtrip_helpers_keep_the_signal(tmp_path: Path) -> None:
    """Lectura y escritura de WAV PCM16 con la biblioteca estándar (la salida de ffmpeg es 16 kHz mono)."""
    path = tmp_path / "x.wav"
    samples = [0, 1000, -1000, 32767, -32768]
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(struct.pack("<5h", *samples))
    rate, data = separate_cli.read_wav_mono(path)
    assert rate == 16000 and list(data) == pytest.approx([s / 32768 for s in samples])
    out = tmp_path / "y.wav"
    separate_cli.write_wav_mono(out, rate, data)
    again_rate, again = separate_cli.read_wav_mono(out)
    assert again_rate == 16000 and list(again) == pytest.approx(list(data), abs=1 / 32768)


def test_write_clips_instead_of_overflowing(tmp_path: Path) -> None:
    out = tmp_path / "clip.wav"
    separate_cli.write_wav_mono(out, 16000, [2.0, -2.0, 0.5])
    _, data = separate_cli.read_wav_mono(out)
    assert list(data) == pytest.approx([32767 / 32768, -1.0, 0.5], abs=1e-4)
