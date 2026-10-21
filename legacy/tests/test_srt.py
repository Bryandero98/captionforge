import pytest

from captionforge.srt import (
    Segment,
    WordTiming,
    format_ass_timestamp,
    format_timestamp,
    format_vtt_timestamp,
    segment_from_dict,
    segment_to_dict,
    segments_from_dicts,
    segments_to_ass,
    segments_to_dicts,
    segments_to_srt,
    segments_to_vtt,
)
from captionforge.ffmpeg_utils import STYLE_PRESETS


class TestFormatTimestamp:
    def test_zero(self):
        assert format_timestamp(0) == "00:00:00,000"

    def test_sub_second(self):
        assert format_timestamp(1.234) == "00:00:01,234"

    def test_rounds_to_nearest_millisecond(self):
        # 1.2345s -> 1234.5ms -> round() to even -> 1234ms (banker's rounding)
        assert format_timestamp(1.2345) == "00:00:01,234"

    def test_minutes_and_hours(self):
        assert format_timestamp(3661.5) == "01:01:01,500"

    def test_over_an_hour(self):
        assert format_timestamp(7325.05) == "02:02:05,050"

    def test_negative_raises(self):
        with pytest.raises(ValueError):
            format_timestamp(-1)


class TestSegmentsToSrt:
    def test_empty_list(self):
        assert segments_to_srt([]) == ""

    def test_single_segment(self):
        result = segments_to_srt([Segment(start=0.0, end=2.5, text="Hello world")])
        assert result == "1\n00:00:00,000 --> 00:00:02,500\nHello world\n"

    def test_multiple_segments_are_blank_line_separated_and_numbered(self):
        segments = [
            Segment(start=0.0, end=1.0, text="First"),
            Segment(start=1.0, end=2.0, text="Second"),
            Segment(start=2.0, end=3.0, text="Third"),
        ]
        result = segments_to_srt(segments)
        expected = (
            "1\n00:00:00,000 --> 00:00:01,000\nFirst\n"
            "\n"
            "2\n00:00:01,000 --> 00:00:02,000\nSecond\n"
            "\n"
            "3\n00:00:02,000 --> 00:00:03,000\nThird\n"
        )
        assert result == expected
        # Exactly one trailing newline, no doubled blank line at the end.
        assert not result.endswith("\n\n")

    def test_strips_surrounding_whitespace_from_segment_text(self):
        result = segments_to_srt([Segment(start=0.0, end=1.0, text="  padded text  ")])
        assert "padded text" in result
        assert "  padded text  " not in result


class TestFormatVttTimestamp:
    def test_uses_dot_not_comma(self):
        assert format_vtt_timestamp(1.234) == "00:00:01.234"

    def test_negative_raises(self):
        with pytest.raises(ValueError):
            format_vtt_timestamp(-1)


class TestSegmentsToVtt:
    def test_header_and_no_numeric_index(self):
        result = segments_to_vtt([Segment(start=0.0, end=2.5, text="Hello world")])
        assert result == "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello world\n"

    def test_empty_list_is_just_the_header(self):
        assert segments_to_vtt([]) == "WEBVTT\n\n"


class TestFormatAssTimestamp:
    def test_single_digit_hour_and_centiseconds(self):
        assert format_ass_timestamp(3661.55) == "1:01:01.55"

    def test_zero(self):
        assert format_ass_timestamp(0) == "0:00:00.00"

    def test_negative_raises(self):
        with pytest.raises(ValueError):
            format_ass_timestamp(-1)


class TestSegmentsToAss:
    def test_plain_segment_has_no_karaoke_tags(self):
        result = segments_to_ass([Segment(start=0.0, end=1.0, text="Hello")], STYLE_PRESETS["modern"])
        assert "[Script Info]" in result
        assert "[V4+ Styles]" in result
        assert "Style: Default," in result
        assert "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello" in result
        assert r"\k" not in result

    def test_segment_with_words_renders_karaoke_tags(self):
        words = [
            WordTiming(start=0.0, end=0.5, text="Hello"),
            WordTiming(start=0.5, end=1.0, text="world"),
        ]
        segment = Segment(start=0.0, end=1.0, text="Hello world", words=words)
        result = segments_to_ass([segment], STYLE_PRESETS["modern"])
        assert r"{\k50}Hello{\k50}world" in result

    def test_mixed_karaoke_and_plain_segments_coexist(self):
        segments = [
            Segment(start=0.0, end=1.0, text="plain", words=None),
            Segment(start=1.0, end=2.0, text="hi", words=[WordTiming(start=1.0, end=2.0, text="hi")]),
        ]
        result = segments_to_ass(segments, STYLE_PRESETS["modern"])
        assert "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,plain" in result
        assert r"{\k100}hi" in result

    def test_curly_braces_in_text_are_escaped_so_they_cannot_inject_ass_tags(self):
        segment = Segment(start=0.0, end=1.0, text="say {\\pos(0,0)}hi")
        result = segments_to_ass([segment], STYLE_PRESETS["modern"])
        # The braces (the only ASS override-block syntax) are escaped; a bare
        # backslash outside a `{...}` block has no special meaning to libass,
        # so it's left as-is.
        assert r"say \{\pos(0,0)\}hi" in result

    def test_empty_list_still_has_a_valid_header(self):
        result = segments_to_ass([], STYLE_PRESETS["modern"])
        assert "[Events]" in result
        assert "Dialogue:" not in result


class TestSegmentJsonRoundtrip:
    def test_roundtrips_a_segment_with_words(self):
        words = [WordTiming(start=0.0, end=0.5, text="hi")]
        segment = Segment(start=0.0, end=1.0, text="hi", words=words)
        assert segment_from_dict(segment_to_dict(segment)) == segment

    def test_roundtrips_a_segment_without_words(self):
        segment = Segment(start=0.0, end=1.0, text="hi", words=None)
        assert segment_from_dict(segment_to_dict(segment)) == segment

    def test_roundtrips_a_list(self):
        segments = [
            Segment(start=0.0, end=1.0, text="a", words=[WordTiming(start=0.0, end=1.0, text="a")]),
            Segment(start=1.0, end=2.0, text="b", words=None),
        ]
        assert segments_from_dicts(segments_to_dicts(segments)) == segments
