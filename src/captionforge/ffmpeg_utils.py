"""Pure ffmpeg command construction - this module never executes a subprocess.

Every function here returns an argv list (list[str]) for the caller to run:
scripts/smoke_test_pipeline.py (sync, via subprocess.run) in Phase 0, or
pipeline.py (async, via asyncio.create_subprocess_exec) once FastAPI exists.
Keeping this module free of I/O is what makes it testable with plain asserts
on the returned list, no mocking needed.
"""

from __future__ import annotations

# A modern, legible social-media-style caption look: bold white text over a
# thick black outline plus a soft shadow. Field names/syntax are ASS
# (Advanced SubStation Alpha) style overrides - what ffmpeg's `subtitles`
# filter's `force_style` option expects.
MODERN_SUBTITLE_STYLE = (
    "FontName=Arial,"
    "FontSize=24,"
    "Bold=1,"
    "PrimaryColour=&H00FFFFFF,"
    "OutlineColour=&H00000000,"
    "BorderStyle=1,"
    "Outline=3,"
    "Shadow=1"
)


def build_extract_audio_cmd(video_path: str, audio_path: str) -> list[str]:
    """ffmpeg argv to extract a video's audio track as 16kHz mono WAV - the format faster-whisper expects."""
    return [
        "ffmpeg",
        "-y",
        "-i",
        video_path,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        audio_path,
    ]


def _escape_for_subtitles_filter(path: str) -> str:
    """Escapes a path for safe use inside ffmpeg's `subtitles=` filter argument.

    The filter's own mini-syntax treats ':' as an option separator and
    backslash as its escape character - both appear constantly in a real
    Windows path (e.g. "C:\\Users\\...\\out.srt"), so both need escaping
    before the whole thing is wrapped in single quotes.
    """
    escaped = path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return f"'{escaped}'"


def build_burn_subtitles_cmd(video_path: str, srt_path: str, output_path: str) -> list[str]:
    """ffmpeg argv to burn (hardsub) an .srt into a video with MODERN_SUBTITLE_STYLE."""
    subtitles_filter = (
        f"subtitles=filename={_escape_for_subtitles_filter(srt_path)}:force_style='{MODERN_SUBTITLE_STYLE}'"
    )
    return [
        "ffmpeg",
        "-y",
        "-i",
        video_path,
        "-vf",
        subtitles_filter,
        output_path,
    ]
