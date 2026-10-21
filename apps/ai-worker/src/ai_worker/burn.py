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

from .config import WorkerConfig
from .errors import JobCancelled, JobFailure
from .progress import Progress
from .storage import EtagMismatch, Storage

log = logging.getLogger("ai_worker")

OUTPUT_NAME = "captioned.mp4"


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

        # 3. Archivo de subtítulos. El karaoke solo se usa si algún segmento conserva tiempos por
        #    palabra (la traducción o editar el texto los descarta): usedKaraoke lo informa.
        use_karaoke = karaoke and any(segment.words for segment in segments)
        output = job_dir / OUTPUT_NAME
        if use_karaoke:
            subtitles = job_dir / "karaoke.ass"
            subtitles.write_text(segments_to_ass(segments, resolve_style(style)), encoding="utf-8")
            cmd = build_burn_subtitles_cmd(str(video), str(subtitles), str(output), is_ass=True)
        else:
            subtitles = job_dir / "subtitles.srt"
            subtitles.write_text(segments_to_srt(segments), encoding="utf-8")
            cmd = build_burn_subtitles_cmd(str(video), str(subtitles), str(output), style)

        # 4. ffmpeg. Sin otra fuente, la duración es el final del último segmento (como en la app heredada).
        await progress.report("burning", 0.0, "Quemando los subtítulos")
        total_duration = max((segment.end for segment in segments), default=0.0) or None
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

        return BurnResult.model_validate(
            {"schemaVersion": 1, "jobId": job_id, "usedKaraoke": use_karaoke, "artifacts": {"video": key}}
        ).model_dump(mode="json")
