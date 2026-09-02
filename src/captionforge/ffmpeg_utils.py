"""Pure ffmpeg command construction - this module never executes a subprocess.

Every function here returns an argv list (list[str]) for the caller to run:
scripts/smoke_test_pipeline.py (sync, via subprocess.run) in Phase 0, or
pipeline.py (async, via asyncio.create_subprocess_exec) once FastAPI exists.
Keeping this module free of I/O is what makes it testable with plain asserts
on the returned list, no mocking needed.
"""

from __future__ import annotations

# Four selectable caption looks, each a plain dict of ASS (Advanced
# SubStation Alpha) style fields - the single source of truth both burn paths
# render from: `_style_to_force_style()` below (the SRT + force_style path)
# and srt.py's `segments_to_ass()` (the karaoke .ass Style: line). A preset
# looks the same whether or not karaoke is active for a given burn.
#
# `secondary_colour` only matters for karaoke (it's the "not yet sung" fill
# libass reveals through as each word's `\k` timer completes) - kept on every
# preset regardless, since any preset can be burned with or without karaoke.
# Colours are ASS's own &HAABBGGRR hex (alpha, then blue/green/red - reversed
# from CSS's RRGGBB, and 00 alpha means fully opaque).
STYLE_PRESETS: dict[str, dict[str, object]] = {
    # The original v1 look: bold white text, thick black outline, soft shadow.
    "modern": {
        "font_name": "Arial",
        "font_size": 24,
        "bold": 1,
        "primary_colour": "&H00FFFFFF",
        "secondary_colour": "&H0000D7FF",  # amber - the karaoke "already sung" fill
        "outline_colour": "&H00000000",
        "back_colour": "&H00000000",
        "border_style": 1,
        "outline": 3,
        "shadow": 1,
        "alignment": 2,
        "margin_v": 40,
    },
    # Big, punchy, bright-yellow highlight - built for word-by-word karaoke.
    "tiktok": {
        "font_name": "Arial",
        "font_size": 30,
        "bold": 1,
        "primary_colour": "&H00FFFFFF",
        "secondary_colour": "&H0000D7FF",
        "outline_colour": "&H00000000",
        "back_colour": "&H00000000",
        "border_style": 1,
        "outline": 4,
        "shadow": 0,
        "alignment": 2,
        "margin_v": 60,
    },
    # Classic broadcast look: smaller white text on a solid black box
    # (BorderStyle=3), no outline/shadow needed since the box itself contrasts.
    "youtube": {
        "font_name": "Arial",
        "font_size": 20,
        "bold": 0,
        "primary_colour": "&H00FFFFFF",
        "secondary_colour": "&H0000D7FF",
        "outline_colour": "&H00000000",
        "back_colour": "&H80000000",
        "border_style": 3,
        "outline": 0,
        "shadow": 0,
        "alignment": 2,
        "margin_v": 20,
    },
    # Thin outline, no shadow, smaller font - understated, out of the way.
    "minimal": {
        "font_name": "Arial",
        "font_size": 18,
        "bold": 0,
        "primary_colour": "&H00FFFFFF",
        "secondary_colour": "&H0000D7FF",
        "outline_colour": "&H00000000",
        "back_colour": "&H00000000",
        "border_style": 1,
        "outline": 1,
        "shadow": 0,
        "alignment": 2,
        "margin_v": 20,
    },
}

DEFAULT_STYLE_PRESET = "modern"


def _style_to_force_style(style: dict[str, object]) -> str:
    """Renders a STYLE_PRESETS entry as the `force_style=` value the plain-SRT burn path expects."""
    return (
        f"FontName={style['font_name']},"
        f"FontSize={style['font_size']},"
        f"Bold={style['bold']},"
        f"PrimaryColour={style['primary_colour']},"
        f"OutlineColour={style['outline_colour']},"
        f"BackColour={style['back_colour']},"
        f"BorderStyle={style['border_style']},"
        f"Outline={style['outline']},"
        f"Shadow={style['shadow']},"
        f"Alignment={style['alignment']},"
        f"MarginV={style['margin_v']}"
    )


def resolve_style(style_name: str | None) -> dict[str, object]:
    """Looks up a STYLE_PRESETS entry by name, falling back to the default for an unknown/missing one."""
    return STYLE_PRESETS.get(style_name or DEFAULT_STYLE_PRESET, STYLE_PRESETS[DEFAULT_STYLE_PRESET])


# Backward-compatible alias: the original v1 constant, now derived from
# STYLE_PRESETS["modern"] so there is exactly one place that defines it.
MODERN_SUBTITLE_STYLE = _style_to_force_style(STYLE_PRESETS["modern"])


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


def build_burn_subtitles_cmd(
    video_path: str,
    srt_path: str,
    output_path: str,
    style_name: str = DEFAULT_STYLE_PRESET,
    *,
    is_ass: bool = False,
) -> list[str]:
    """ffmpeg argv to burn (hardsub) subtitles into a video.

    Two modes, chosen by `is_ass`:
    - `is_ass=False` (default): `srt_path` is a plain .srt, styled via
      `force_style` from `style_name` (one of ffmpeg_utils.STYLE_PRESETS).
    - `is_ass=True`: `srt_path` is a .ass file (see srt.py's
      `segments_to_ass()`) that already carries its own Style: line - the
      karaoke burn path, where `\\k` timing tags live inside the text itself
      and `force_style` would only fight the file's own styling. `style_name`
      is ignored in this mode (the .ass file already reflects it).
    """
    if is_ass:
        subtitles_filter = f"subtitles=filename={_escape_for_subtitles_filter(srt_path)}"
    else:
        force_style = _style_to_force_style(resolve_style(style_name))
        escaped_path = _escape_for_subtitles_filter(srt_path)
        subtitles_filter = f"subtitles=filename={escaped_path}:force_style='{force_style}'"
    return [
        "ffmpeg",
        "-y",
        "-i",
        video_path,
        "-vf",
        subtitles_filter,
        output_path,
    ]
