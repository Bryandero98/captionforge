import pytest

from captionforge.srt import Segment, format_timestamp, segments_to_srt


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
