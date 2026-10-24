"""Ayudantes de audio del doblaje (ADR 0020, T9): ajuste de ritmo acotado y ensamblado de la pista sin ffmpeg de por medio."""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from ai_worker.audio import MAX_TEMPO, MIN_TEMPO, RATE, join_wavs, plan_tempo, wav_duration, write_silence


class TestPlanTempo:
    def test_a_voice_that_already_fits_is_left_alone(self) -> None:
        assert plan_tempo(2.0, 2.0) == 1.0
        assert plan_tempo(2.03, 2.0) == 1.0, "una diferencia imperceptible no justifica reprocesar"

    def test_a_longer_voice_is_sped_up_just_enough(self) -> None:
        assert plan_tempo(2.2, 2.0) == pytest.approx(1.1)

    def test_the_speed_up_is_bounded(self) -> None:
        assert plan_tempo(10.0, 2.0) == MAX_TEMPO == 1.25

    def test_a_shorter_voice_is_slowed_down_but_never_beyond_the_floor(self) -> None:
        assert plan_tempo(1.8, 2.0) == pytest.approx(0.9)
        assert plan_tempo(0.2, 2.0) == MIN_TEMPO == 0.85

    @pytest.mark.parametrize("duration", [0.1, 0.5, 1.0, 3.0, 30.0])
    @pytest.mark.parametrize("slot", [0.2, 1.0, 5.0])
    def test_the_tempo_is_always_inside_the_allowed_range(self, duration: float, slot: float) -> None:
        assert MIN_TEMPO <= plan_tempo(duration, slot) <= MAX_TEMPO

    def test_a_degenerate_slot_does_not_divide_by_zero(self) -> None:
        assert plan_tempo(1.0, 0.0) == MAX_TEMPO
        assert plan_tempo(1.0, -3.0) == MAX_TEMPO


class TestWavs:
    def test_silence_has_the_requested_duration_and_the_common_format(self, tmp_path: Path) -> None:
        path = tmp_path / "s.wav"
        write_silence(path, 1.5)
        assert wav_duration(path) == pytest.approx(1.5, abs=1 / RATE)
        with wave.open(str(path), "rb") as wav:
            assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, RATE)
            assert set(wav.readframes(wav.getnframes())) == {0}

    def test_joining_sums_the_durations_and_keeps_the_order(self, tmp_path: Path) -> None:
        loud = tmp_path / "loud.wav"
        with wave.open(str(loud), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes((b"\x10\x10") * RATE)  # 1 s no silencioso
        quiet = tmp_path / "quiet.wav"
        write_silence(quiet, 0.5)
        out = tmp_path / "all.wav"
        join_wavs([quiet, loud, quiet], out)
        assert wav_duration(out) == pytest.approx(2.0, abs=2 / RATE)
        with wave.open(str(out), "rb") as wav:
            frames = wav.readframes(wav.getnframes())
        half = RATE // 2 * 2
        assert set(frames[:half]) == {0} and set(frames[half : half + RATE * 2]) == {0x10} and set(frames[-half:]) == {0}

    def test_joining_rejects_a_different_format(self, tmp_path: Path) -> None:
        odd = tmp_path / "odd.wav"
        with wave.open(str(odd), "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(b"\0" * 400)
        ok = tmp_path / "ok.wav"
        write_silence(ok, 0.1)
        with pytest.raises(ValueError):
            join_wavs([ok, odd], tmp_path / "out.wav")

    def test_joining_nothing_yields_an_empty_track(self, tmp_path: Path) -> None:
        out = tmp_path / "empty.wav"
        join_wavs([], out)
        assert wav_duration(out) == 0.0
