import os
from unittest.mock import MagicMock, patch

from captionforge.srt import Segment, WordTiming
from captionforge.translate import translate_segments


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

    def test_translates_text_but_preserves_start_end_and_words(self):
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
        assert translated.words == words
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
