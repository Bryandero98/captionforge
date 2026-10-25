"""Quemado de subtítulos: descarga el video y los subtítulos aprobados, los quema con ffmpeg y sube el video."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
from pathlib import Path
from typing import Any

from captionforge.ffmpeg_utils import build_burn_subtitles_cmd, resolve_style
from captionforge.pipeline import _run_ffmpeg
from captionforge.srt import segments_from_dicts, segments_to_ass, segments_to_srt
from captionforge_contracts import BurnJob, BurnResult

from .ass_render import get_template, paginate, render_ass, words_of
from .config import WorkerConfig
from .audio import has_video_stream, media_info
from .errors import JobCancelled, JobFailure
from .progress import Progress
from .storage import EtagMismatch, Storage
from .vertical import CANVAS_HEIGHT, CANVAS_WIDTH, VideoGeometry, build_source_cmd, build_vertical_cmd, parse_geometry

log = logging.getLogger("ai_worker")

OUTPUT_NAME = "captioned.mp4"
# Plantilla de los subtítulos dinámicos cuando se pide el formato 9:16 sin elegir una.
DEFAULT_TEMPLATE = "bold-pop"


class BurnRunner:
    def __init__(self, config: WorkerConfig, storage: Storage) -> None:
        self._config = config
        self._storage = storage

    async def run(self, payload: BurnJob, progress: Progress, cancel: threading.Event) -> dict[str, Any]:
        """Devuelve el BurnResult (como dict JSON). Lanza JobCancelled o la excepción original."""
        job_dir = self._config.work_dir / str(payload.jobId)
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            return await self._run(payload, progress, cancel, job_dir)
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)

    @staticmethod
    def _check(cancel: threading.Event) -> None:
        if cancel.is_set():
            raise JobCancelled()

    async def _run(self, payload: BurnJob, progress: Progress, cancel: threading.Event, job_dir: Path) -> dict[str, Any]:
        job_id = str(payload.jobId)
        style = str(payload.options.style.value)
        karaoke = bool(payload.options.karaoke)
        template_name = payload.options.template.value if payload.options.template else None
        vertical = bool(payload.options.canvas) and payload.options.canvas.value == "vertical"
        if vertical and template_name is None:
            template_name = DEFAULT_TEMPLATE

        # 1. Subtítulos aprobados. If-Match: si se editaron después de pedir el quemado, no se quema
        #    una versión que el usuario ya no aprobó.
        await progress.report("downloading_input", 0.0, "Leyendo los subtítulos aprobados")
        ref = payload.segments
        try:
            raw = await asyncio.to_thread(self._storage.read_if_match, ref.bucket, ref.objectKey, ref.etag)
        except EtagMismatch as error:
            raise JobFailure(
                "SEGMENTS_CHANGED", "Los subtítulos cambiaron después de pedir el quemado. Vuelve a pedirlo."
            ) from error
        try:
            segments = segments_from_dicts(json.loads(raw))
        except Exception as error:  # noqa: BLE001 - un archivo corrupto es un fallo interno, no del usuario
            log.error("segments.json ilegible en el trabajo %s", job_id, exc_info=error)
            raise JobFailure("INTERNAL", "Los subtítulos guardados no se pueden leer.") from error
        self._check(cancel)

        # 2. Video original
        await progress.report("downloading_input", 0.3, "Descargando el video")
        video = job_dir / "input.bin"
        await asyncio.to_thread(self._storage.download, payload.input.bucket, payload.input.objectKey, video)
        self._check(cancel)
        if not await has_video_stream(video):
            # El API ya lo rechaza para un audio; esto cubre un trabajo que llegue por otro camino.
            raise JobFailure("BURN_NEEDS_VIDEO", "Un archivo de audio no tiene imagen: no se pueden quemar subtítulos.")

        # 3. Archivo de subtítulos. Con plantilla (subtítulos dinámicos) se compila un .ass paginado por palabras: los segmentos
        #    sin tiempos reales (texto editado o traducido) reparten el tiempo y se cuentan como aproximados.
        #    Sin plantilla, el karaoke solo se usa si algún segmento conserva tiempos por palabra: usedKaraoke lo informa.
        output = job_dir / OUTPUT_NAME
        approximate: int | None = None
        if template_name:
            use_karaoke = True
            template = get_template(template_name)
            approximate = sum(1 for segment in segments if words_of(segment)[1])
            subtitles = job_dir / "captions.ass"
            # Si no se puede leer la forma del video se trata como 16:9, el caso más común.
            geometry = parse_geometry(await media_info(video)) or VideoGeometry(1920, 1080)
            canvas = (CANVAS_WIDTH, CANVAS_HEIGHT) if vertical else (geometry.width, geometry.height)
            subtitles.write_text(render_ass(paginate(segments, template.max_words), template, canvas), encoding="utf-8")
            fonts = self._config.fonts_dir
            if vertical:
                cmd = build_vertical_cmd(
                    str(video), str(subtitles), str(output), geometry, fonts, max_seconds=self._config.vertical_max_seconds
                )
            else:
                cmd = build_source_cmd(str(video), str(subtitles), str(output), geometry, fonts)
        elif karaoke and any(segment.words for segment in segments):
            use_karaoke = True
            subtitles = job_dir / "karaoke.ass"
            subtitles.write_text(segments_to_ass(segments, resolve_style(style)), encoding="utf-8")
            cmd = build_burn_subtitles_cmd(str(video), str(subtitles), str(output), is_ass=True)
        else:
            use_karaoke = False
            subtitles = job_dir / "subtitles.srt"
            subtitles.write_text(segments_to_srt(segments), encoding="utf-8")
            cmd = build_burn_subtitles_cmd(str(video), str(subtitles), str(output), style)

        # 4. ffmpeg. Sin otra fuente, la duración es el final del último segmento (como en la app heredada).
        await progress.report("burning", 0.0, "Quemando los subtítulos")
        total_duration = max((segment.end for segment in segments), default=0.0) or None
        if vertical and total_duration:
            total_duration = min(total_duration, float(self._config.vertical_max_seconds))
        await _run_ffmpeg(
            cmd,
            on_progress=lambda fraction: progress.report_threadsafe(
                "burning", fraction, f"Quemando los subtítulos ({fraction * 100:.0f}%)"
            ),
            total_duration=total_duration,
            stall_timeout=self._config.ffmpeg_stall_timeout,
            total_timeout=self._config.ffmpeg_total_timeout,
        )
        self._check(cancel)

        # 5. Resultado
        await progress.report("uploading", 0.0, "Subiendo el video")
        key = f"{payload.outputPrefix}{OUTPUT_NAME}"
        await asyncio.to_thread(self._storage.upload_file, output, key, "video/mp4")

        result: dict[str, Any] = {"schemaVersion": 1, "jobId": job_id, "usedKaraoke": use_karaoke, "artifacts": {"video": key}}
        if approximate is not None:
            result["approximateSegments"] = approximate
        return BurnResult.model_validate(result).model_dump(mode="json", exclude_none=True)
