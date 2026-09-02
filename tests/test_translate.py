import os
from unittest.mock import MagicMock, patch

from captionforge.srt import Segment, WordTiming
from captionforge.translate import _ensure_language_pair_installed, translate_segments


class TestComputeTypeOverride:
    def test_forces_float32_unless_already_set(self):
        # Regression test: argostranslate's default compute_type="auto"
        # resolves to a quantized kernel that was verified live to silently
        # produce garbage, repetition-loop translations (no error raised) -
        # importing this module must force float32 unless the environment
        # already opted into something else on purpose.
        assert os.environ.get("ARGOS_COMPUTE_TYPE") == "float32"


class TestTranslateSegments:
    def test_same_language_pair_is_a_no_op_and_never_touches_argostranslate(self):
        segments = [Segment(start=0.0, end=1.0, text="hola")]
        with patch("captionforge.translate._ensure_language_pair_installed") as ensure_mock:
            result = translate_segments(segments, "es", "es")
        assert result == segments
        ensure_mock.assert_not_called()

    def test_translates_text_and_preserves_start_end_but_drops_words(self):
        words = [WordTiming(start=0.0, end=0.5, text="hola")]
        segments = [Segment(start=0.0, end=1.0, text="hola", words=words)]

        fake_translation = MagicMock()
        fake_translation.translate.return_value = "hello"

        with (
            patch("captionforge.translate._ensure_language_pair_installed"),
            patch("captionforge.translate._get_translation", return_value=fake_translation),
        ):
            result = translate_segments(segments, "es", "en")

        assert len(result) == 1
        translated = result[0]
        assert translated.text == "hello"
        assert translated.start == 0.0
        assert translated.end == 1.0
        # The original-language per-word timing no longer lines up with the
        # translated text (different words/order/count) - keeping it would
        # feed a karaoke renderer a mismatched word/timing pair.
        assert translated.words is None
        fake_translation.translate.assert_called_once_with("hola")

    def test_raises_a_clear_error_if_the_pair_still_cant_load_after_install_attempt(self):
        segments = [Segment(start=0.0, end=1.0, text="hola")]
        with (
            patch("captionforge.translate._ensure_language_pair_installed"),
            patch("captionforge.translate._get_translation", return_value=None),
        ):
            try:
                translate_segments(segments, "es", "en")
                raised = False
            except RuntimeError:
                raised = True
        assert raised


class TestPackageDownloadMessageIsConsoleSafe:
    def test_the_download_progress_message_encodes_as_cp1252_without_raising(self, capsys):
        # Regression test: a literal U+2192 arrow in this message once
        # crashed the FIRST download of a new language pair with
        # UnicodeEncodeError - verified live requesting a genuinely new pair
        # (en->es) against the real server on Windows, whose console/redirected
        # stdout defaults to cp1252, not UTF-8. es->en didn't reproduce it
        # because that pair's package was already installed from earlier
        # testing, so the download branch (and its print()) never ran.
        # cp1252 is the strictest realistic target here; anything that
        # survives it survives every other Windows console codepage too.
        fake_package = MagicMock(from_code="en", to_code="es")
        fake_package.download.return_value = "/fake/path.argosmodel"
        with (
            patch("captionforge.translate._get_translation", return_value=None),
            patch("argostranslate.package.update_package_index"),
            patch("argostranslate.package.get_available_packages", return_value=[fake_package]),
            patch("argostranslate.package.install_from_path"),
        ):
            _ensure_language_pair_installed("en", "es")

        printed = capsys.readouterr().out
        assert printed  # sanity: the message actually printed something
        printed.encode("cp1252")  # must not raise UnicodeEncodeError
