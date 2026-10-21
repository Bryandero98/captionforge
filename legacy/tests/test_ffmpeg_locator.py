import sys
from pathlib import Path

import pytest

from captionforge import ffmpeg_locator
from captionforge.ffmpeg_locator import find_ffmpeg, with_ffmpeg_path


def _fake_exe(tmp_path: Path, name: str) -> str:
    exe = tmp_path / name
    exe.write_text("")
    exe.chmod(0o755)  # find_ffmpeg requires an executable file (os.access X_OK); a no-op on Windows
    return str(exe)


def _fake_bundled(monkeypatch, path: str):
    class FakeImageioFfmpeg:
        @staticmethod
        def get_ffmpeg_exe() -> str:
            return path

    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", FakeImageioFfmpeg)


def _no_bundled(monkeypatch):
    # A None entry in sys.modules makes `import imageio_ffmpeg` raise ImportError.
    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", None)


def test_env_override_wins_over_everything(tmp_path, monkeypatch):
    override = _fake_exe(tmp_path, "mi-ffmpeg")
    _fake_bundled(monkeypatch, _fake_exe(tmp_path, "bundled"))
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setenv("CAPTIONFORGE_FFMPEG", override)

    assert find_ffmpeg() == override


def test_bundled_is_preferred_over_system_ffmpeg(tmp_path, monkeypatch):
    # The bundled build is the one known to ship libass (the `subtitles` filter);
    # a system ffmpeg may not (e.g. plain Homebrew ffmpeg on macOS).
    bundled = _fake_exe(tmp_path, "bundled")
    _fake_bundled(monkeypatch, bundled)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    assert find_ffmpeg() == bundled


def test_falls_back_to_system_ffmpeg_when_bundled_is_missing(monkeypatch):
    _no_bundled(monkeypatch)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    assert find_ffmpeg() == "/usr/bin/ffmpeg"


def test_falls_back_to_system_when_bundled_binary_file_is_gone(tmp_path, monkeypatch):
    _fake_bundled(monkeypatch, str(tmp_path / "no-existe"))
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    assert find_ffmpeg() == "/usr/bin/ffmpeg"


def test_ignores_env_override_that_does_not_exist(tmp_path, monkeypatch):
    bundled = _fake_exe(tmp_path, "bundled")
    _fake_bundled(monkeypatch, bundled)
    monkeypatch.setenv("CAPTIONFORGE_FFMPEG", str(tmp_path / "no-existe"))

    assert find_ffmpeg() == bundled


def test_returns_none_when_nothing_is_available(monkeypatch):
    _no_bundled(monkeypatch)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: None)

    assert find_ffmpeg() is None


def test_with_ffmpeg_path_replaces_only_the_command_name(tmp_path, monkeypatch):
    bundled = _fake_exe(tmp_path, "bundled")
    _fake_bundled(monkeypatch, bundled)

    cmd = ["ffmpeg", "-y", "-i", "ffmpeg", "out.wav"]

    assert with_ffmpeg_path(cmd) == [bundled, "-y", "-i", "ffmpeg", "out.wav"]


def test_with_ffmpeg_path_raises_a_clear_error_when_missing(monkeypatch):
    _no_bundled(monkeypatch)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: None)

    with pytest.raises(FileNotFoundError, match="ffmpeg"):
        with_ffmpeg_path(["ffmpeg", "-version"])


def test_invalid_env_override_is_ignored_with_a_warning(tmp_path, monkeypatch, caplog):
    bundled = _fake_exe(tmp_path, "bundled")
    _fake_bundled(monkeypatch, bundled)
    monkeypatch.setenv("CAPTIONFORGE_FFMPEG", "ffmpeg")  # a bare name is not a full path to an executable

    with caplog.at_level("WARNING", logger="captionforge.ffmpeg_locator"):
        assert find_ffmpeg() == bundled

    assert "CAPTIONFORGE_FFMPEG" in caplog.text


def test_bundled_binary_without_execute_permission_falls_back_to_system(tmp_path, monkeypatch, caplog):
    bundled = _fake_exe(tmp_path, "bundled")
    _fake_bundled(monkeypatch, bundled)
    monkeypatch.setattr(ffmpeg_locator.os, "access", lambda path, mode: path != bundled)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    with caplog.at_level("WARNING", logger="captionforge.ffmpeg_locator"):
        assert find_ffmpeg() == "/usr/bin/ffmpeg"

    assert "no existe o no es ejecutable" in caplog.text


def test_bundled_lookup_that_raises_is_logged_and_falls_back(monkeypatch, caplog):
    class Broken:
        @staticmethod
        def get_ffmpeg_exe() -> str:
            raise RuntimeError("no hay binario para esta plataforma")

    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", Broken)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    with caplog.at_level("WARNING", logger="captionforge.ffmpeg_locator"):
        assert find_ffmpeg() == "/usr/bin/ffmpeg"

    assert "no hay binario para esta plataforma" in caplog.text


def test_falling_back_to_the_path_warns_that_libass_may_be_missing(monkeypatch, caplog):
    _no_bundled(monkeypatch)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    with caplog.at_level("WARNING", logger="captionforge.ffmpeg_locator"):
        find_ffmpeg()

    assert "libass" in caplog.text


def test_missing_ffmpeg_message_tells_how_to_fix_it(monkeypatch):
    _no_bundled(monkeypatch)
    monkeypatch.setattr(ffmpeg_locator.shutil, "which", lambda _name: None)

    with pytest.raises(FileNotFoundError) as excinfo:
        with_ffmpeg_path(["ffmpeg"])

    assert "pip install imageio-ffmpeg" in str(excinfo.value)
    assert "CAPTIONFORGE_FFMPEG" in str(excinfo.value)
