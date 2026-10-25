"""Comprobación de la imagen de despliegue: el worker, Whisper y ffmpeg trabajan juntos de verdad.

Se ejecuta DENTRO de la imagen (`docker run --entrypoint python IMAGEN -`, con este archivo por stdin).
Existe porque una versión nueva de PyAV (19) rompió `faster_whisper.audio.decode_audio` mientras todo lo
demás importaba bien: un `import` no basta, hay que decodificar audio de verdad.

Lo mismo con el quemado de subtítulos: `python:3.12-slim` no trae fuentes ni configuración de fontconfig, y
libass (dentro de ffmpeg) sin ellas falla o dibuja el video sin texto, sin que nada más lo note. Por eso se
quema un subtítulo de verdad, por los dos caminos del worker (SRT y ASS de karaoke), y se mira el fotograma.
"""

import os
import subprocess
import tempfile

import argostranslate.translate  # noqa: F401 - se importa de forma diferida en el worker
import captionforge_contracts  # noqa: F401
from captionforge.ffmpeg_locator import ffmpeg_env, find_ffmpeg, with_ffmpeg_path
from captionforge.ffmpeg_utils import STYLE_PRESETS, build_burn_subtitles_cmd
from captionforge.srt import Segment, WordTiming, segments_to_ass
from faster_whisper.audio import decode_audio

import ai_worker.worker  # noqa: F401

# Texto blanco sobre negro: si libass dibujó algo, hay píxeles claros. Con 640x360 un subtítulo de varias
# palabras tiene miles; el umbral deja margen y excluye el ruido de la compresión.
MIN_TEXT_PIXELS = 300

ffmpeg = find_ffmpeg()
assert ffmpeg, "no se encontró ffmpeg"
with tempfile.TemporaryDirectory() as folder:
    wav = os.path.join(folder, "silencio.wav")
    subprocess.run(
        [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-y", wav],
        check=True,
    )
    samples = decode_audio(wav)  # la llamada que fallaba con PyAV 19
    assert len(samples) > 0, "decode_audio no devolvió muestras"


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess[bytes]:
    """Igual que el worker: ejecutable resuelto por `with_ffmpeg_path` y entorno mínimo `ffmpeg_env`."""
    return subprocess.run(
        with_ffmpeg_path(["ffmpeg", "-v", "warning", *args]),
        capture_output=True,
        env=ffmpeg_env(),
        check=False,
    )


def bright_pixels(video: str) -> int:
    """Píxeles claros del fotograma a 1 s (escala de grises, 8 bits)."""
    frame = run_ffmpeg(["-ss", "1", "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
    assert frame.returncode == 0, frame.stderr.decode(errors="replace")[-500:]
    # 100: las palabras aún no cantadas del karaoke van en ámbar (gris ~202), muy cerca de un corte en 200.
    return sum(1 for value in frame.stdout if value > 100)


def check_burn(label: str, folder: str, background: str, subtitles: str, *, is_ass: bool) -> None:
    output = os.path.join(folder, f"quemado-{label}.mp4")
    cmd = build_burn_subtitles_cmd(background, subtitles, output, is_ass=is_ass)
    result = run_ffmpeg(cmd[1:])  # `run_ffmpeg` antepone "ffmpeg"
    stderr = result.stderr.decode(errors="replace")
    assert result.returncode == 0, f"el quemado {label} falló (código {result.returncode}): {stderr[-600:]}"
    # Sin fuentes libass avisa por fontconfig y sigue adelante: el video sale sin texto y con código 0.
    problems = ("fontconfig error", "failed to find any fallback", "failed to load fonctconfig")
    assert not any(problem in stderr.lower() for problem in problems), (
        f"fontconfig sin configuración o sin fuentes ({label}): {stderr[-600:]}"
    )
    pixels = bright_pixels(output)
    assert pixels >= MIN_TEXT_PIXELS, (
        f"el quemado {label} no dibujó texto ({pixels} píxeles claros; mínimo {MIN_TEXT_PIXELS}). "
        f"Revisa que la imagen tenga fuentes y fontconfig. Salida de ffmpeg: {stderr[-600:]}"
    )


with tempfile.TemporaryDirectory() as folder:
    background = os.path.join(folder, "fondo.mp4")
    made = run_ffmpeg(
        ["-f", "lavfi", "-i", "color=c=black:s=640x360:d=2:r=10", "-pix_fmt", "yuv420p", "-y", background]
    )
    assert made.returncode == 0, made.stderr.decode(errors="replace")[-500:]

    srt = os.path.join(folder, "subtitulos.srt")
    with open(srt, "w", encoding="utf-8") as handle:
        handle.write("1\n00:00:00,000 --> 00:00:02,000\nHOLA MUNDO, esto es una prueba de subtítulos\n")
    check_burn("srt", folder, background, srt, is_ass=False)

    # Con palabras con tiempos, para que el ASS lleve etiquetas \k de karaoke de verdad (sin ellas es una línea plana).
    words = [
        WordTiming(start=i * 0.4, end=i * 0.4 + 0.4, text=word, probability=0.9)
        for i, word in enumerate(("HOLA", "MUNDO", "esto", "es", "una", "prueba"))
    ]
    segment = Segment(start=0.0, end=2.4, text="HOLA MUNDO esto es una prueba", words=words)
    ass = os.path.join(folder, "karaoke.ass")
    with open(ass, "w", encoding="utf-8") as handle:
        handle.write(segments_to_ass([segment], STYLE_PRESETS["modern"]))
    with open(ass, encoding="utf-8") as handle:
        assert "\\k" in handle.read(), (
            "el ASS de karaoke no lleva etiquetas de karaoke (k): no se prueba el karaoke"
        )
    check_burn("karaoke", folder, background, ass, is_ass=True)

    # Los estilos piden Arial: debe resolverse a su sustituta de mismas medidas, no a la fuente de respaldo.
    arial = subprocess.run(
        ["fc-match", "-f", "%{family}", "Arial"], capture_output=True, text=True, check=True
    ).stdout
    assert "Liberation" in arial, (
        f"Arial se resuelve a {arial!r} en vez de Liberation Sans (¿falta fonts-liberation?)"
    )

    # Subtítulos dinámicos (.ass paginado) en formato 9:16: las dos fuentes empaquetadas deben resolverse de verdad (libass avisa
    # «fontselect» con la fuente elegida; si cayera a DejaVu el video saldría con otra tipografía y código 0).
    from ai_worker.ass_render import TEMPLATES, get_template, paginate, render_ass
    from ai_worker.vertical import CANVAS_HEIGHT, CANVAS_WIDTH, VideoGeometry, build_vertical_cmd

    fonts_dir = "/usr/share/fonts/truetype/captionforge"  # el mismo valor por defecto que WorkerConfig.fonts_dir
    for name in TEMPLATES:
        template = get_template(name)
        family = template.font
        match = subprocess.run(["fc-match", "-f", "%{family}|%{file}", family], capture_output=True, text=True, check=True).stdout
        assert family.split()[0] in match and fonts_dir in match, f"{family} se resuelve a {match!r}: ¿faltan las fuentes empaquetadas?"
        words = [
            WordTiming(start=i * 0.4, end=i * 0.4 + 0.4, text=word, probability=0.9)
            for i, word in enumerate(("HOLA", "MUNDO", "esto", "es", "una", "prueba"))
        ]
        pages = paginate([Segment(start=0.0, end=2.4, text="HOLA MUNDO esto es una prueba", words=words)], template.max_words)
        captions = os.path.join(folder, f"dinamico-{name}.ass")
        with open(captions, "w", encoding="utf-8") as handle:
            handle.write(render_ass(pages, template, (CANVAS_WIDTH, CANVAS_HEIGHT)))
        output = os.path.join(folder, f"vertical-{name}.mp4")
        cmd = build_vertical_cmd(background, captions, output, VideoGeometry(640, 360, 10.0), fonts_dir)
        cmd[cmd.index("-v") + 1] = "verbose"
        result = run_ffmpeg(cmd[1:])
        stderr = result.stderr.decode(errors="replace")
        assert result.returncode == 0, f"el quemado 9:16 ({name}) falló: {stderr[-600:]}"
        picked = [line for line in stderr.splitlines() if "fontselect" in line and family in line]
        assert picked and all("default" not in line.lower() for line in picked), f"libass no usó {family}: {stderr[-800:]}"
        assert bright_pixels(output) >= MIN_TEXT_PIXELS, f"el quemado 9:16 ({name}) no dibujó texto"

print("imagen correcta: ffmpeg, decode_audio, el quemado de subtítulos (SRT y karaoke) y el formato 9:16 con las fuentes empaquetadas funcionan")
