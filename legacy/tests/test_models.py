"""Tests for models.py - cache/size/disk-space checks. No real network or disk writes:

huggingface_hub and shutil.disk_usage are mocked throughout, so these never
depend on what's actually cached on the machine running them.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from huggingface_hub.errors import LocalEntryNotFoundError

from captionforge.models import (
    InsufficientDiskSpaceError,
    UnknownModelSizeError,
    assert_model_fits,
    download_model_with_progress,
    is_model_cached,
    model_preflight,
)

# Comfortably above every _APPROX_BYTES entry plus headroom, and comfortably
# below it - used to drive the fits/doesn't-fit branches without hardcoding
# this module's own private byte constants into the test.
_PLENTY_OF_DISK = 50 * 1024**3
_TIGHT_DISK = 10 * 1024**2


class TestIsModelCached:
    def test_true_when_snapshot_download_finds_every_file_locally(self):
        with patch("captionforge.models.snapshot_download", return_value="/fake/path"):
            assert is_model_cached("small") is True

    def test_false_when_snapshot_download_reports_a_local_miss(self):
        with patch("captionforge.models.snapshot_download", side_effect=LocalEntryNotFoundError("miss")):
            assert is_model_cached("medium") is False

    def test_never_hits_the_network__local_files_only_is_always_set(self):
        with patch("captionforge.models.snapshot_download", return_value="/fake/path") as mock_dl:
            is_model_cached("base")
        assert mock_dl.call_args.kwargs["local_files_only"] is True

    def test_unknown_model_size_raises_before_touching_the_hub(self):
        with patch("captionforge.models.snapshot_download") as mock_dl, pytest.raises(UnknownModelSizeError):
            is_model_cached("gigantic")
        mock_dl.assert_not_called()


class TestModelPreflight:
    def test_cached_model_always_fits_regardless_of_free_disk(self, tmp_path):
        with (
            patch("captionforge.models.is_model_cached", return_value=True),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": 0})()),
        ):
            result = model_preflight("small", destination=tmp_path)
        assert result.cached is True
        assert result.fits is True

    def test_not_cached_and_plenty_of_disk_fits(self, tmp_path):
        with (
            patch("captionforge.models.is_model_cached", return_value=False),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": _PLENTY_OF_DISK})()),
        ):
            result = model_preflight("medium", destination=tmp_path)
        assert result.cached is False
        assert result.fits is True
        assert result.free_bytes == _PLENTY_OF_DISK

    def test_not_cached_and_almost_no_disk_does_not_fit(self, tmp_path):
        with (
            patch("captionforge.models.is_model_cached", return_value=False),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": _TIGHT_DISK})()),
        ):
            result = model_preflight("medium", destination=tmp_path)
        assert result.fits is False

    def test_approx_bytes_grows_with_model_size(self, tmp_path):
        with (
            patch("captionforge.models.is_model_cached", return_value=False),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": _PLENTY_OF_DISK})()),
        ):
            base = model_preflight("base", destination=tmp_path)
            small = model_preflight("small", destination=tmp_path)
            medium = model_preflight("medium", destination=tmp_path)
        assert base.approx_bytes < small.approx_bytes < medium.approx_bytes


class TestDownloadModelWithProgress:
    def test_passes_repo_id_allow_patterns_and_a_tqdm_class_through(self):
        with patch("captionforge.models.snapshot_download") as mock_dl:
            download_model_with_progress("small", lambda n, total: None)
        args, kwargs = mock_dl.call_args
        assert args[0] == "Systran/faster-whisper-small"
        expected_patterns = [
            "config.json",
            "preprocessor_config.json",
            "model.bin",
            "tokenizer.json",
            "vocabulary.*",
        ]
        assert kwargs["allow_patterns"] == expected_patterns
        assert isinstance(kwargs["tqdm_class"], type)

    def test_on_progress_only_fires_for_the_byte_counter_bar(self):
        """snapshot_download's own tqdm_class hook is instantiated for more than one bar
        (see huggingface_hub._snapshot_download - a byte counter plus a file-count bar) -
        this simulates both, the way huggingface_hub's real _AggregatedTqdm does (setting
        .total post-construction, then calling .update()), to prove the callback only
        reacts to the one whose numbers are actually bytes.
        """
        samples: list[tuple[int, int]] = []

        def fake_snapshot_download(repo_id, allow_patterns=None, tqdm_class=None):
            byte_bar = tqdm_class(desc="Downloading bytes", total=0, initial=0, unit="B", unit_scale=True)
            byte_bar.total = 100
            byte_bar.update(40)
            byte_bar.update(60)

            file_bar = tqdm_class(desc="Fetching 4 files", total=4, initial=0)
            file_bar.update(4)

        with patch("captionforge.models.snapshot_download", side_effect=fake_snapshot_download):
            download_model_with_progress("base", lambda n, total: samples.append((n, total)))

        assert samples == [(40, 100), (100, 100)]

    def test_propagates_a_real_snapshot_download_failure(self):
        with (
            patch("captionforge.models.snapshot_download", side_effect=OSError("disco lleno")),
            pytest.raises(OSError, match="disco lleno"),
        ):
            download_model_with_progress("base", lambda n, total: None)


class TestAssertModelFits:
    def test_raises_when_preflight_says_it_does_not_fit(self):
        with (
            patch("captionforge.models.is_model_cached", return_value=False),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": _TIGHT_DISK})()),
            pytest.raises(InsufficientDiskSpaceError),
        ):
            assert_model_fits("medium")

    def test_says_nothing_when_it_fits(self):
        with (
            patch("captionforge.models.is_model_cached", return_value=True),
            patch("shutil.disk_usage", return_value=type("D", (), {"free": 0})()),
        ):
            assert_model_fits("small")  # must not raise
