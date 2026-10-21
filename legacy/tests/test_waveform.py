"""_downsample_peaks is pure (plain asserts, no ffmpeg); compute_waveform_peaks runs real
ffmpeg against the real fixture clip - same "no mocking the actual pipeline" posture as
test_pipeline.py's own real-ffmpeg tests.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from captionforge.waveform import WaveformExtractionError, _downsample_peaks, compute_waveform_peaks

FIXTURE = Path(__file__).parent / "fixtures" / "tiny_test_clip.mp4"


class TestDownsamplePeaks:
    def test_silence_is_zero_amplitude(self):
        assert _downsample_peaks(bytes([128, 128, 128]), max_peaks=10) == [0.0, 0.0, 0.0]

    def test_full_scale_samples_are_near_amplitude_one(self):
        # 0 and 255 are the u8 extremes - 0 is exactly 128 away from the
        # silence midpoint (amplitude 1.0 exactly); 255 is only 127 away
        # (u8's range is asymmetric around 128), so its amplitude is 127/128,
        # not quite 1.0 - both are still "essentially full volume".
        peaks = _downsample_peaks(bytes([0, 255]), max_peaks=10)
        assert peaks[0] == pytest.approx(1.0)
        assert peaks[1] == pytest.approx(127 / 128)

    def test_empty_input_returns_an_empty_list(self):
        assert _downsample_peaks(b"", max_peaks=10) == []

    def test_fewer_samples_than_max_peaks_returns_one_peak_per_sample(self):
        samples = bytes([128, 200, 64])
        assert len(_downsample_peaks(samples, max_peaks=100)) == 3

    def test_more_samples_than_max_peaks_downsamples_to_the_cap(self):
        samples = bytes([128] * 1000)
        assert len(_downsample_peaks(samples, max_peaks=10)) == 10

    def test_a_bucket_reports_its_loudest_sample_not_an_average(self):
        # One loud (255) sample buried in an otherwise-silent bucket must
        # still show up at near-full amplitude - a bucket AVERAGE would smear
        # it down to something much smaller instead. 6 samples over 2 peaks
        # -> bucket 0 is samples[0:3] (silent), bucket 1 is samples[3:6]
        # (contains the one loud sample).
        samples = bytes([128, 128, 128, 255, 128, 128])
        peaks = _downsample_peaks(samples, max_peaks=2)
        assert peaks[0] == pytest.approx(0.0)
        assert peaks[1] == pytest.approx(127 / 128)


class TestComputeWaveformPeaksReal:
    def test_returns_peaks_and_a_plausible_duration_for_the_real_fixture(self):
        peaks, duration = compute_waveform_peaks(FIXTURE)
        assert len(peaks) > 0
        assert all(0.0 <= p <= 1.0 for p in peaks)
        # The fixture is a real, ffprobe-measured ~10.1s clip (see
        # test_pipeline.py's FIXTURE_DURATION_SECONDS) - loose bounds here
        # since this module's own duration is derived from decoded sample
        # count, not a separate ffprobe call.
        assert 8 < duration < 12

    def test_a_nonexistent_video_raises_a_readable_error(self, tmp_path):
        missing = tmp_path / "does-not-exist.mp4"
        with pytest.raises(WaveformExtractionError):
            compute_waveform_peaks(missing)


class TestComputeWaveformUsesResolvedExecutable:
    def test_runs_the_resolved_ffmpeg_not_the_bare_name(self, monkeypatch):
        monkeypatch.setattr("captionforge.ffmpeg_locator.find_ffmpeg", lambda: "/ruta/ffmpeg-resuelto")
        captured: dict = {}

        class FakeResult:
            returncode = 0
            stdout = bytes([128, 200, 128, 60])
            stderr = b""

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return FakeResult()

        monkeypatch.setattr("captionforge.waveform.subprocess.run", fake_run)

        peaks, _duration = compute_waveform_peaks(FIXTURE)

        assert captured["cmd"][0] == "/ruta/ffmpeg-resuelto"
        assert peaks  # the fake audio was decoded into peaks

    def test_missing_ffmpeg_becomes_a_waveform_error_with_the_actionable_message(self, monkeypatch):
        monkeypatch.setattr("captionforge.ffmpeg_locator.find_ffmpeg", lambda: None)

        with pytest.raises(WaveformExtractionError, match="CAPTIONFORGE_FFMPEG"):
            compute_waveform_peaks(FIXTURE)

    def test_a_non_executable_ffmpeg_becomes_a_waveform_error(self, monkeypatch):
        monkeypatch.setattr("captionforge.ffmpeg_locator.find_ffmpeg", lambda: "/ruta/ffmpeg-resuelto")

        def fake_run(cmd, **kwargs):
            raise PermissionError("[Errno 13] Permission denied")

        monkeypatch.setattr("captionforge.waveform.subprocess.run", fake_run)

        with pytest.raises(WaveformExtractionError, match="Permission denied"):
            compute_waveform_peaks(FIXTURE)

    def test_a_real_ffmpeg_in_a_folder_with_spaces_selected_via_env_var_works_end_to_end(
        self, tmp_path, monkeypatch
    ):
        from captionforge.ffmpeg_locator import find_ffmpeg

        real = find_ffmpeg()
        if real is None:
            pytest.skip("no ffmpeg available on this machine")
        import shutil

        folder = tmp_path / "carpeta con espacios"
        folder.mkdir()
        copied = folder / Path(real).name
        shutil.copy2(real, copied)
        monkeypatch.setenv("CAPTIONFORGE_FFMPEG", str(copied))

        peaks, duration = compute_waveform_peaks(FIXTURE)

        assert peaks
        assert duration > 0
