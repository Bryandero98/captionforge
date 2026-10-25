"""Formato 9:16 (Issue #13, parte 2): lectura de la geometría y construcción del comando de ffmpeg.

Las pruebas de tabla no necesitan ffmpeg; las de integración usan el ffmpeg REAL (sin infraestructura):
generan un clip sintético, queman un .ass de verdad y miden la salida."""

from __future__ import annotations

import asyncio
import re
import subprocess
from pathlib import Path

import pytest
from captionforge.ffmpeg_locator import ffmpeg_env, find_ffmpeg, with_ffmpeg_path
from captionforge.pipeline import _run_ffmpeg
from captionforge.srt import Segment, WordTiming

from ai_worker.ass_render import get_template, paginate, render_ass
from ai_worker.vertical import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    MAX_VERTICAL_SECONDS,
    VideoGeometry,
    build_source_cmd,
    build_vertical_cmd,
    parse_geometry,
)

FONTS = Path(__file__).resolve().parents[1] / "fonts"
FONTS_DIR = "/usr/share/fonts/truetype/captionforge"

LANDSCAPE = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr"
PORTRAIT = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1080x1920 [SAR 1:1 DAR 9:16], 29.97 fps, 30 tbr"
ROTATED = (
    "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 24 fps, 24 tbr\n"
    "    Side data:\n      displaymatrix: rotation of -90.00 degrees"
)
ANAMORPHIC = "  Stream #0:0: Video: h264, yuv420p, 720x576 [SAR 16:15 DAR 4:3], 25 fps, 25 tbr"
COVER_ART = "  Stream #0:1: Video: mjpeg, yuvj444p, 500x500 [SAR 1:1 DAR 1:1], 90k tbr (attached pic)"
AUDIO_ONLY = "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s"


# ---------------------------------------------------------------------------------------------- geometría


def test_parse_geometry_reads_a_landscape_video() -> None:
    geometry = parse_geometry(LANDSCAPE)
    assert geometry == VideoGeometry(width=1920, height=1080, fps=30.0, square_pixels=True)
    assert not geometry.is_vertical


def test_parse_geometry_reads_a_portrait_video_with_a_fractional_frame_rate() -> None:
    geometry = parse_geometry(PORTRAIT)
    assert (geometry.width, geometry.height, geometry.fps) == (1080, 1920, 29.97)
    assert geometry.is_vertical


def test_parse_geometry_swaps_the_sides_of_a_rotated_video() -> None:
    # ffmpeg aplica la rotación del contenedor al decodificar: el lienzo se decide con la forma que se VE.
    geometry = parse_geometry(ROTATED)
    assert (geometry.width, geometry.height) == (1080, 1920)
    assert geometry.is_vertical


def test_parse_geometry_applies_a_non_square_pixel_aspect() -> None:
    geometry = parse_geometry(ANAMORPHIC)
    assert (geometry.width, geometry.height) == (768, 576)
    assert geometry.square_pixels is False


def test_parse_geometry_ignores_cover_art_and_audio_only_files() -> None:
    assert parse_geometry(COVER_ART) is None
    assert parse_geometry(AUDIO_ONLY) is None
    assert parse_geometry("") is None


def test_parse_geometry_does_not_confuse_a_codec_tag_with_the_size() -> None:
    line = "  Stream #0:0: Video: mpeg4 (Simple Profile) (mp4v / 0x7634706D), yuv420p, 640x360, 25 fps"
    geometry = parse_geometry(line)
    assert geometry is not None and (geometry.width, geometry.height) == (640, 360)


@pytest.mark.parametrize(
    ("width", "height", "vertical"),
    [(1080, 1920, True), (720, 1280, True), (1080, 1350, False), (1080, 1080, False), (1920, 1080, False), (1080, 1921, True)],
)
def test_is_vertical_means_nine_by_sixteen_or_narrower(width: int, height: int, vertical: bool) -> None:
    assert VideoGeometry(width=width, height=height, fps=30.0).is_vertical is vertical


# ---------------------------------------------------------------------------------------------- comando 9:16


def vertical_cmd(geometry: VideoGeometry, **kwargs):  # noqa: ANN003, ANN202
    return build_vertical_cmd("/work/j/input.bin", "/work/j/captions.ass", "/work/j/captioned.mp4", geometry, FONTS_DIR, **kwargs)


def option(cmd: list[str], name: str) -> str:
    return cmd[cmd.index(name) + 1]


def test_landscape_uses_the_blurred_background_graph_from_the_plan() -> None:
    cmd = vertical_cmd(VideoGeometry(1920, 1080, 30.0))
    assert option(cmd, "-filter_complex") == (
        "[0:v]split=2[bg][fg];"
        "[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=luma_radius=12:luma_power=2,"
        "scale=1080:1920:flags=bicubic,setsar=1[bgb];"
        "[fg]scale=1080:-2:flags=lanczos,setsar=1[fgs];"
        "[bgb][fgs]overlay=x=(W-w)/2:y=(H-h)/2:format=auto,"
        f"ass=filename='/work/j/captions.ass':fontsdir='{FONTS_DIR}'[v]"
    )


def test_a_vertical_input_skips_the_blurred_background() -> None:
    graph = option(vertical_cmd(VideoGeometry(1080, 1920, 30.0)), "-filter_complex")
    assert "split" not in graph and "boxblur" not in graph and "overlay" not in graph
    assert graph == (
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,"
        f"ass=filename='/work/j/captions.ass':fontsdir='{FONTS_DIR}'[v]"
    )


def test_non_square_pixels_are_corrected_before_the_graph() -> None:
    graph = option(vertical_cmd(VideoGeometry(768, 576, 25.0, square_pixels=False)), "-filter_complex")
    assert graph.startswith("[0:v]scale='trunc(iw*sar/2)*2':ih,setsar=1[src];[src]split=2[bg][fg];")


def test_encoding_options_match_the_approved_decisions() -> None:
    cmd = vertical_cmd(VideoGeometry(1920, 1080, 30.0))
    assert cmd[0] == "ffmpeg" and cmd[-1] == "/work/j/captioned.mp4"
    assert option(cmd, "-c:v") == "libx264"
    assert option(cmd, "-preset") == "veryfast"
    assert option(cmd, "-crf") == "21"
    assert option(cmd, "-pix_fmt") == "yuv420p"
    assert option(cmd, "-c:a") == "aac" and option(cmd, "-b:a") == "160k"
    assert option(cmd, "-movflags") == "+faststart"
    assert option(cmd, "-filter_threads") == "2" and option(cmd, "-filter_complex_threads") == "2"
    assert option(cmd, "-t") == str(MAX_VERTICAL_SECONDS) == "600"
    # El audio es opcional («?»): un video mudo no falla; y el progreso sale de las estadísticas.
    assert [cmd[i + 1] for i, token in enumerate(cmd) if token == "-map"] == ["[v]", "0:a:0?"]
    assert "-stats" in cmd and option(cmd, "-v") == "warning"


@pytest.mark.parametrize(("fps", "expected"), [(24.0, "24"), (29.97, "29.97"), (60.0, "30"), (120.0, "30")])
def test_frame_rate_follows_the_source_with_a_cap_of_thirty(fps: float, expected: str) -> None:
    assert option(vertical_cmd(VideoGeometry(1920, 1080, fps)), "-r") == expected


def test_an_unknown_frame_rate_is_left_to_ffmpeg() -> None:
    assert "-r" not in vertical_cmd(VideoGeometry(1920, 1080, None))


def test_the_duration_cap_is_configurable() -> None:
    assert option(vertical_cmd(VideoGeometry(1920, 1080, 30.0), max_seconds=90), "-t") == "90"


def test_paths_with_spaces_colons_and_quotes_cannot_break_out_of_the_filter() -> None:
    cmd = build_vertical_cmd(
        "/work/j/input.bin", "C:\\tmp\\it's a file.ass", "/work/j/out.mp4", VideoGeometry(1920, 1080, 30.0), "D:\\fuentes aquí"
    )
    graph = option(cmd, "-filter_complex")
    assert "ass=filename='C\\:\\\\tmp\\\\it\\'s a file.ass':fontsdir='D\\:\\\\fuentes aquí'[v]" in graph
    assert len(cmd) == len(vertical_cmd(VideoGeometry(1920, 1080, 30.0))), "el argv no cambia de forma según las rutas"


def test_only_integers_and_fixed_text_reach_the_graph() -> None:
    graph = option(vertical_cmd(VideoGeometry(1920, 1080, 30.0)), "-filter_complex")
    assert f"scale={CANVAS_WIDTH}:{CANVAS_HEIGHT}" in graph
    assert (CANVAS_WIDTH, CANVAS_HEIGHT) == (1080, 1920)


# ---------------------------------------------------------------------------------------------- comando «source»


def test_source_canvas_only_burns_the_ass_over_the_original_picture() -> None:
    cmd = build_source_cmd("/work/j/input.bin", "/work/j/captions.ass", "/work/j/out.mp4", VideoGeometry(1920, 1080, 30.0), FONTS_DIR)
    assert option(cmd, "-vf") == f"scale=trunc(iw/2)*2:trunc(ih/2)*2,ass=filename='/work/j/captions.ass':fontsdir='{FONTS_DIR}'"
    assert "-filter_complex" not in cmd
    assert option(cmd, "-preset") == "veryfast" and option(cmd, "-crf") == "21"
    assert "-t" not in cmd, "el tope de 10 min es del formato vertical, no del quemado normal"
    assert [cmd[i + 1] for i, token in enumerate(cmd) if token == "-map"] == ["0:v:0", "0:a:0?"]


# ---------------------------------------------------------------------------------------------- ffmpeg real

needs_ffmpeg = pytest.mark.skipif(find_ffmpeg() is None, reason="no hay ffmpeg")


def ffmpeg(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        with_ffmpeg_path(["ffmpeg", "-hide_banner", *args]), capture_output=True, text=True, env=ffmpeg_env(), check=False
    )


def make_clip(path: Path, size: str, *, seconds: int = 3, audio: bool = True) -> None:
    args = ["-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", *(["-c:a", "aac"] if audio else []), str(path)]
    result = ffmpeg(*args)
    assert result.returncode == 0, result.stderr[-500:]


def sample_ass(path: Path, template: str) -> None:
    words = [WordTiming(start=0.2 + i * 0.4, end=0.55 + i * 0.4, text=w) for i, w in enumerate(["Hola", "mundo", "esto", "es", "CaptionForge"])]
    segment = Segment(start=0.2, end=2.4, text="Hola mundo esto es CaptionForge", words=words)
    page_template = get_template(template)
    pages = paginate([segment], page_template.max_words)
    path.write_text(render_ass(pages, page_template, (CANVAS_WIDTH, CANVAS_HEIGHT)), encoding="utf-8")


def probe(path: Path) -> tuple[VideoGeometry | None, float, bool]:
    stderr = ffmpeg("-i", str(path)).stderr
    duration = re.search(r"Duration: (\d+):(\d+):([\d.]+)", stderr)
    assert duration, stderr[-300:]
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    return parse_geometry(stderr), seconds, " Audio:" in stderr


def run_cmd(cmd: list[str]) -> None:
    asyncio.run(_run_ffmpeg(cmd, stall_timeout=60, total_timeout=120))


@needs_ffmpeg
@pytest.mark.parametrize(("size", "template"), [("640x360", "bold-pop"), ("360x640", "rounded-sweep"), ("480x480", "clean-color")])
def test_real_ffmpeg_composes_a_1080x1920_video_with_audio(tmp_path: Path, size: str, template: str) -> None:
    source, subtitles, output = tmp_path / "in.mp4", tmp_path / "captions.ass", tmp_path / "out.mp4"
    make_clip(source, size)
    sample_ass(subtitles, template)
    geometry, _, _ = probe(source)
    assert geometry is not None

    run_cmd(build_vertical_cmd(str(source), str(subtitles), str(output), geometry, str(FONTS)))

    out_geometry, seconds, has_audio = probe(output)
    assert out_geometry is not None and (out_geometry.width, out_geometry.height) == (1080, 1920)
    assert 2.7 <= seconds <= 3.4
    assert has_audio


@needs_ffmpeg
def test_real_ffmpeg_cuts_a_long_input_at_the_duration_cap(tmp_path: Path) -> None:
    source, subtitles, output = tmp_path / "in.mp4", tmp_path / "captions.ass", tmp_path / "out.mp4"
    make_clip(source, "320x180", seconds=6)
    sample_ass(subtitles, "bold-pop")
    run_cmd(build_vertical_cmd(str(source), str(subtitles), str(output), VideoGeometry(320, 180, 30.0), str(FONTS), max_seconds=2))
    assert 1.7 <= probe(output)[1] <= 2.4


@needs_ffmpeg
def test_real_ffmpeg_accepts_a_silent_video(tmp_path: Path) -> None:
    source, subtitles, output = tmp_path / "in.mp4", tmp_path / "captions.ass", tmp_path / "out.mp4"
    make_clip(source, "320x180", audio=False)
    sample_ass(subtitles, "bold-pop")
    run_cmd(build_vertical_cmd(str(source), str(subtitles), str(output), VideoGeometry(320, 180, 30.0), str(FONTS)))
    geometry, _, has_audio = probe(output)
    assert geometry is not None and not has_audio


@needs_ffmpeg
@pytest.mark.parametrize("family", ["Montserrat ExtraBold", "Nunito ExtraBold"])
def test_libass_resolves_the_bundled_fonts_instead_of_falling_back(tmp_path: Path, family: str) -> None:
    template = "bold-pop" if family.startswith("Montserrat") else "rounded-sweep"
    source, subtitles, output = tmp_path / "in.mp4", tmp_path / "captions.ass", tmp_path / "out.mp4"
    make_clip(source, "320x180", seconds=2)
    sample_ass(subtitles, template)
    cmd = build_vertical_cmd(str(source), str(subtitles), str(output), VideoGeometry(320, 180, 30.0), str(FONTS))
    cmd[cmd.index("-v") + 1] = "verbose"
    result = ffmpeg(*cmd[1:])
    assert result.returncode == 0, result.stderr[-500:]
    selected = [line for line in result.stderr.splitlines() if "fontselect" in line and family in line]
    assert selected, f"libass no pidió {family}:\n" + "\n".join(line for line in result.stderr.splitlines() if "font" in line.lower())[-800:]
    assert all("default" not in line.lower() for line in selected), selected
    assert any(re.search(rf"{family.split()[0]}-ExtraBold", line) for line in selected), selected


@needs_ffmpeg
def test_source_canvas_keeps_the_original_size(tmp_path: Path) -> None:
    source, subtitles, output = tmp_path / "in.mp4", tmp_path / "captions.ass", tmp_path / "out.mp4"
    make_clip(source, "640x360")
    sample_ass(subtitles, "clean-color")
    run_cmd(build_source_cmd(str(source), str(subtitles), str(output), VideoGeometry(640, 360, 30.0), str(FONTS)))
    geometry, seconds, has_audio = probe(output)
    assert geometry is not None and (geometry.width, geometry.height) == (640, 360)
    assert 2.7 <= seconds <= 3.4 and has_audio
