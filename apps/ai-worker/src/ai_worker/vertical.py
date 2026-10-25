"""Formato 9:16 y quemado de subtítulos dinámicos: lectura de la geometría del video y comandos de ffmpeg.

Todo es puro (texto adentro, argv afuera). El grafo de filtros se arma solo con enteros y rutas fijas del
trabajo: ninguna cadena del usuario entra al `filter_complex` (la plantilla elige un archivo .ass, no un fragmento
de filtro). Diseño en `tasks/plan.md`, pilar 2.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CANVAS_WIDTH = 1080
CANVAS_HEIGHT = 1920
# Tope de duración de la salida 9:16 (decisión del Tech Lead). Lo hace cumplir el API (413) y, por si acaso, `-t`.
MAX_VERTICAL_SECONDS = 600
MAX_FPS = 30

_SIZE = re.compile(r",\s*(\d{2,5})x(\d{2,5})\b")
_SAR = re.compile(r"\bSAR (\d+):(\d+)")
_FPS = re.compile(r"(\d+(?:\.\d+)?) fps")
_ROTATION = re.compile(r"rotation of (-?\d+(?:\.\d+)?) degrees")


@dataclass(frozen=True)
class VideoGeometry:
    """Forma con la que el video SE VE: ya con la rotación del contenedor y la proporción del píxel aplicadas."""

    width: int
    height: int
    fps: float | None = None
    square_pixels: bool = True

    @property
    def is_vertical(self) -> bool:
        """9:16 o más estrecho: se rellena el lienzo sin fondo desenfocado."""
        return self.width * 16 <= self.height * 9


def parse_geometry(ffmpeg_info: str) -> VideoGeometry | None:
    """Lee la salida de `ffmpeg -i`. None si no hay imagen en movimiento (un audio con carátula no cuenta)."""
    lines = ffmpeg_info.splitlines()
    for index, line in enumerate(lines):
        if " Video:" not in line or "attached pic" in line:
            continue
        size = _SIZE.search(line)
        if not size:
            return None
        width, height = int(size[1]), int(size[2])
        sar = _SAR.search(line)
        square = True
        if sar and int(sar[2]) and int(sar[1]) != int(sar[2]):
            width = round(width * int(sar[1]) / int(sar[2]))
            square = False
        # La rotación (displaymatrix) va en las líneas de datos laterales de ESTE flujo, antes del siguiente.
        for follow in lines[index + 1 :]:
            if "Stream #" in follow:
                break
            rotation = _ROTATION.search(follow)
            if rotation:
                if round(abs(float(rotation[1]))) % 180 == 90:
                    width, height = height, width
                break
        fps = _FPS.search(line)
        return VideoGeometry(width, height, float(fps[1]) if fps else None, square)
    return None


def _quote(value: str) -> str:
    """Valor entre comillas simples para un filtro de ffmpeg: escapa la barra, los dos puntos y la comilla."""
    escaped = value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return f"'{escaped}'"


def _ass_filter(ass_path: str, fonts_dir: str) -> str:
    return f"ass=filename={_quote(ass_path)}:fontsdir={_quote(fonts_dir)}"


def _square_pixels(geometry: VideoGeometry) -> str:
    """Prefijo del grafo: devuelve la entrada ya con píxeles cuadrados para que el escalado no deforme la imagen."""
    if geometry.square_pixels:
        return "[0:v]"
    return "[0:v]scale='trunc(iw*sar/2)*2':ih,setsar=1[src];[src]"


def _encoding(geometry: VideoGeometry) -> list[str]:
    args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]
    if geometry.fps:
        args += ["-r", f"{min(geometry.fps, MAX_FPS):g}"]
    return [*args, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]


def build_vertical_cmd(
    video: str,
    ass_path: str,
    output: str,
    geometry: VideoGeometry,
    fonts_dir: str,
    *,
    max_seconds: int = MAX_VERTICAL_SECONDS,
) -> list[str]:
    """Compone el video en 1080x1920 y quema el .ass encima, en un solo pase.

    Entrada ancha (o cuadrada): fondo = el mismo video ampliado, a baja resolución y desenfocado; el video va centrado a
    todo el ancho. Entrada ya vertical: se rellena el lienzo recortando lo que sobre. Los subtítulos se queman al final,
    sobre el lienzo ya compuesto, para que sus coordenadas sean las de 9:16.
    """
    head = _square_pixels(geometry)
    captions = _ass_filter(ass_path, fonts_dir)
    if geometry.is_vertical:
        graph = (
            f"{head}scale={CANVAS_WIDTH}:{CANVAS_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={CANVAS_WIDTH}:{CANVAS_HEIGHT},setsar=1,{captions}[v]"
        )
    else:
        small_w, small_h = CANVAS_WIDTH // 4, CANVAS_HEIGHT // 4
        graph = (
            f"{head}split=2[bg][fg];"
            f"[bg]scale={small_w}:{small_h}:force_original_aspect_ratio=increase,crop={small_w}:{small_h},"
            f"boxblur=luma_radius=12:luma_power=2,scale={CANVAS_WIDTH}:{CANVAS_HEIGHT}:flags=bicubic,setsar=1[bgb];"
            f"[fg]scale={CANVAS_WIDTH}:-2:flags=lanczos,setsar=1[fgs];"
            f"[bgb][fgs]overlay=x=(W-w)/2:y=(H-h)/2:format=auto,{captions}[v]"
        )
    return [
        "ffmpeg", "-y", "-v", "warning", "-stats", "-hide_banner",
        "-i", video,
        "-filter_threads", "2", "-filter_complex_threads", "2",
        "-filter_complex", graph,
        "-map", "[v]", "-map", "0:a:0?",
        *_encoding(geometry),
        "-t", str(max_seconds),
        output,
    ]  # fmt: skip


def build_source_cmd(video: str, ass_path: str, output: str, geometry: VideoGeometry, fonts_dir: str) -> list[str]:
    """Quema el .ass sobre la imagen original, sin cambiar su forma (`canvas: "source"`). Sin tope de duración."""
    return [
        "ffmpeg", "-y", "-v", "warning", "-stats", "-hide_banner",
        "-i", video,
        "-vf", f"scale=trunc(iw/2)*2:trunc(ih/2)*2,{_ass_filter(ass_path, fonts_dir)}",
        "-map", "0:v:0", "-map", "0:a:0?",
        *_encoding(geometry),
        output,
    ]  # fmt: skip
