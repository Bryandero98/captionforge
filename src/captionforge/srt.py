"""Pure .srt formatting/assembly logic - no I/O, no Whisper, no ffmpeg.

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
