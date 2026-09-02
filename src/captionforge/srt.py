"""Pure subtitle formatting/assembly logic - no I/O, no Whisper, no ffmpeg.

Renders a list of Segments as .srt, .vtt, or karaoke-capable .ass text, plus
the plain-dict (de)serialization used to persist segments to segments.json.
Kept deliberately dependency-free (stdlib only) so it's testable with plain
asserts, independent of any real transcription ever running.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WordTiming:
    """One word's timing within a Segment - from faster-whisper's word_timestamps=True.

    Not used to render the v1 .srt (which is segment-level), but captured now
    so a future word-by-word "karaoke" caption UI doesn't need to touch the
    transcription pipeline again, only the rendering layer.
    """

    start: float
    end: float
    text: str


@dataclass(frozen=True)
class Segment:
    """One transcribed (or translated) subtitle segment."""

    start: float
    end: float
    text: str
    words: list[WordTiming] | None = None


def format_timestamp(seconds: float) -> str:
    """Formats a duration in seconds as SRT's HH:MM:SS,mmm timestamp."""
    if seconds < 0:
        raise ValueError(f"timestamp cannot be negative: {seconds}")
    total_ms = round(seconds * 1000)
    hours, remainder_ms = divmod(total_ms, 3_600_000)
    minutes, remainder_ms = divmod(remainder_ms, 60_000)
    secs, ms = divmod(remainder_ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def segments_to_srt(segments: list[Segment]) -> str:
    """Renders a list of Segments as a complete .srt file's text content.

    Each block already ends in its own newline, so joining with a blank-line
    separator produces the standard "index / time range / text / blank line"
    SRT shape with exactly one trailing newline - no double blank at the end.
    """
    blocks = [
        f"{index}\n"
        f"{format_timestamp(segment.start)} --> {format_timestamp(segment.end)}\n"
        f"{segment.text.strip()}\n"
        for index, segment in enumerate(segments, start=1)
    ]
    return "\n".join(blocks)


def format_vtt_timestamp(seconds: float) -> str:
    """Formats a duration in seconds as WebVTT's HH:MM:SS.mmm timestamp (dot, not comma)."""
    if seconds < 0:
        raise ValueError(f"timestamp cannot be negative: {seconds}")
    total_ms = round(seconds * 1000)
    hours, remainder_ms = divmod(total_ms, 3_600_000)
    minutes, remainder_ms = divmod(remainder_ms, 60_000)
    secs, ms = divmod(remainder_ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def segments_to_vtt(segments: list[Segment]) -> str:
    """Renders a list of Segments as a complete WebVTT file's text content.

    Same shape as .srt (one cue per Segment) but with the "WEBVTT" header
    required by the spec, no numeric cue index, and dot-separated
    milliseconds - the format a plain HTML <video><track> expects natively.
    """
    blocks = [
        f"{format_vtt_timestamp(segment.start)} --> {format_vtt_timestamp(segment.end)}\n"
        f"{segment.text.strip()}\n"
        for segment in segments
    ]
    return "WEBVTT\n\n" + "\n".join(blocks)


def format_ass_timestamp(seconds: float) -> str:
    """Formats a duration in seconds as ASS's H:MM:SS.cc timestamp (centiseconds, single-digit hour)."""
    if seconds < 0:
        raise ValueError(f"timestamp cannot be negative: {seconds}")
    total_cs = round(seconds * 100)
    hours, remainder_cs = divmod(total_cs, 360_000)
    minutes, remainder_cs = divmod(remainder_cs, 6_000)
    secs, cs = divmod(remainder_cs, 100)
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    """Neutralizes ASS override-block syntax in caption text so it can't inject styling/karaoke tags.

    `{` opens an override block (arbitrary `\\tags`) and `}` closes one - both
    have to be escaped for text that comes from a transcription/translation
    engine (or a user edit), which has no reason to ever contain real ASS
    syntax. `\\N`/`\\n` (line breaks) aren't relevant here: Segment.text is a
    single line by construction.
    """
    return text.replace("{", r"\{").replace("}", r"\}")


def _segment_to_ass_dialogue_text(segment: Segment) -> str:
    """One segment's `Text` field: karaoke-tagged if word timings survived, plain otherwise."""
    if not segment.words:
        return _ass_escape(segment.text.strip())

    parts = []
    for word in segment.words:
        duration_cs = max(round((word.end - word.start) * 100), 0)
        parts.append(f"{{\\k{duration_cs}}}{_ass_escape(word.text)}")
    return "".join(parts)


def segments_to_ass(segments: list[Segment], style: dict[str, object]) -> str:
    """Renders Segments as a complete .ass (Advanced SubStation Alpha) file.

    Every segment that still carries `words` (untouched by translation or a
    manual text edit - see translate.py and the segment-edit route) renders as
    a per-word `\\k` karaoke line; every other segment renders as a plain
    line. Both kinds can coexist in the same file. `style` is one of
    ffmpeg_utils.STYLE_PRESETS - the single source of truth this and the
    plain-SRT `force_style` burn path both read from, so a preset looks the
    same whether or not karaoke is active for a given burn.
    """
    style_line = (
        "Style: Default,"
        f"{style['font_name']},{style['font_size']},"
        f"{style['primary_colour']},{style['secondary_colour']},"
        f"{style['outline_colour']},{style['back_colour']},"
        f"{style['bold']},0,0,0,100,100,0,0,"
        f"{style['border_style']},{style['outline']},{style['shadow']},"
        f"{style['alignment']},10,10,{style['margin_v']},1"
    )
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{style_line}\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    dialogue_lines = [
        f"Dialogue: 0,{format_ass_timestamp(segment.start)},{format_ass_timestamp(segment.end)},"
        f"Default,,0,0,0,,{_segment_to_ass_dialogue_text(segment)}"
        for segment in segments
    ]
    return header + "\n".join(dialogue_lines) + ("\n" if dialogue_lines else "")


def word_timing_to_dict(word: WordTiming) -> dict:
    return {"start": word.start, "end": word.end, "text": word.text}


def segment_to_dict(segment: Segment) -> dict:
    """Round-trippable plain-dict form of a Segment, for persisting to segments.json."""
    return {
        "start": segment.start,
        "end": segment.end,
        "text": segment.text,
        "words": [word_timing_to_dict(w) for w in segment.words] if segment.words else None,
    }


def segment_from_dict(data: dict) -> Segment:
    words = data.get("words")
    return Segment(
        start=data["start"],
        end=data["end"],
        text=data["text"],
        words=[WordTiming(start=w["start"], end=w["end"], text=w["text"]) for w in words] if words else None,
    )


def segments_to_dicts(segments: list[Segment]) -> list[dict]:
    return [segment_to_dict(s) for s in segments]


def segments_from_dicts(data: list[dict]) -> list[Segment]:
    return [segment_from_dict(d) for d in data]
