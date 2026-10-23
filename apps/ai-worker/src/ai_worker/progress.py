"""Progreso del trabajo: lo escribe en PostgreSQL (fuente de verdad del API) y en BullMQ."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from captionforge_contracts import JobProgress

from .db import JobRepository

log = logging.getLogger("ai_worker")

# Rangos del porcentaje GLOBAL (0-100) por etapa: así el progreso es monótono aunque el modelo se
# descargue o no.
STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 5.0),
    "extracting_audio": (5.0, 10.0),
    "downloading_model": (10.0, 20.0),
    "transcribing": (20.0, 85.0),
    "translating": (85.0, 90.0),
    "uploading": (90.0, 99.0),
}

# Con limpieza de audio (cleanAudio) hay dos etapas más antes de Whisper: el rango se reparte de otro modo, pero
# sigue siendo monótono de 0 a 99.
CLEAN_STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 4.0),
    "extracting_audio": (4.0, 8.0),
    "downloading_separation_model": (8.0, 12.0),
    "separating_voice": (12.0, 40.0),
    "downloading_model": (40.0, 44.0),
    "transcribing": (44.0, 86.0),
    "translating": (86.0, 90.0),
    "uploading": (90.0, 99.0),
}

# Identificar hablantes (diarize): después de Whisper, que se suelta antes de lanzar el hijo de pyannote.
DIARIZE_STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 4.0),
    "extracting_audio": (4.0, 8.0),
    "downloading_model": (8.0, 12.0),
    "transcribing": (12.0, 50.0),
    "downloading_diarization_model": (50.0, 55.0),
    "diarizing": (55.0, 86.0),
    "translating": (86.0, 90.0),
    "uploading": (90.0, 99.0),
}

# Las dos opciones a la vez.
CLEAN_DIARIZE_STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 3.0),
    "extracting_audio": (3.0, 6.0),
    "downloading_separation_model": (6.0, 9.0),
    "separating_voice": (9.0, 30.0),
    "downloading_model": (30.0, 33.0),
    "transcribing": (33.0, 60.0),
    "downloading_diarization_model": (60.0, 64.0),
    "diarizing": (64.0, 87.0),
    "translating": (87.0, 90.0),
    "uploading": (90.0, 99.0),
}


def stage_ranges(clean_audio: bool, diarize: bool) -> dict[str, tuple[float, float]]:
    """Reparto del porcentaje según las opciones del trabajo (siempre monótono de 0 a 99)."""
    if clean_audio and diarize:
        return CLEAN_DIARIZE_STAGE_RANGES
    if clean_audio:
        return CLEAN_STAGE_RANGES
    return DIARIZE_STAGE_RANGES if diarize else STAGE_RANGES


# El quemado tiene sus propias etapas: el ffmpeg de codificación es casi todo el trabajo.
BURN_STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 5.0),
    "burning": (5.0, 96.0),
    "uploading": (96.0, 99.0),
}


# Traducir: leer, traducir por lotes (casi todo el tiempo si el proveedor es externo) y guardar.
TRANSLATE_STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 5.0),
    "translating": (5.0, 92.0),
    "uploading": (92.0, 99.0),
}

# Doblar: leer, sintetizar cada frase, ensamblar el audio, mezclar con el video (si se pidió) y subir.
DUB_STAGE_RANGES: dict[str, tuple[float, float]] = {
    "downloading_input": (0.0, 5.0),
    "synthesizing": (5.0, 70.0),
    "mixing": (70.0, 94.0),
    "uploading": (94.0, 99.0),
}


class ProgressSink(Protocol):
    async def updateProgress(self, progress: dict[str, Any]) -> Any: ...  # noqa: N802 - nombre de bullmq.Job


class Progress:
    """Limita la frecuencia (una escritura por segundo salvo cambio de etapa)."""

    def __init__(
        self,
        repo: JobRepository,
        job_id: str,
        loop: asyncio.AbstractEventLoop,
        sink: ProgressSink | None = None,
        min_interval: float = 1.0,
        ranges: dict[str, tuple[float, float]] | None = None,
        on_closed: Callable[[], None] | None = None,
    ) -> None:
        self._on_closed = on_closed
        self._ranges = STAGE_RANGES if ranges is None else ranges
        self._repo = repo
        self._job_id = job_id
        self._loop = loop
        self._sink = sink
        self._min_interval = min_interval
        self._last_stage: str | None = None
        self._last_at = 0.0
        self._last_percent = 0.0

    def use_ranges(self, ranges: dict[str, tuple[float, float]]) -> None:
        """Cambia el reparto de etapas (el porcentaje ya publicado no retrocede)."""
        self._ranges = ranges

    def scale(self, stage: str, fraction: float) -> float:
        low, high = self._ranges[stage]
        return low + (high - low) * min(max(fraction, 0.0), 1.0)

    async def report(self, stage: str, fraction: float, message: str) -> None:
        """`fraction` es el avance (0-1) DENTRO de la etapa."""
        now = time.monotonic()
        if stage == self._last_stage and now - self._last_at < self._min_interval:
            return
        percent = max(self.scale(stage, fraction), self._last_percent)  # nunca retrocede
        self._last_stage, self._last_at, self._last_percent = stage, now, percent
        try:
            if not await self._repo.report(self._job_id, stage, round(percent, 1), message):
                # La fila ya no está RUNNING: la cerró la API (cancelación) o el recolector. Seguir sería
                # gastar horas de CPU en un trabajo que nadie espera.
                log.warning("el trabajo %s ya no está en curso; se aborta", self._job_id)
                if self._on_closed is not None:
                    self._on_closed()
                return
            if self._sink is not None:
                message_model = JobProgress.model_validate(
                    {"schemaVersion": 1, "stage": stage, "percent": round(percent, 1), "message": message}
                )
                await self._sink.updateProgress(message_model.model_dump(mode="json"))
        except Exception:  # noqa: BLE001 - informar el progreso nunca debe tumbar el trabajo
            log.warning("no se pudo escribir el progreso", exc_info=True)

    def report_threadsafe(self, stage: str, fraction: float, message: str) -> None:
        """Para llamar desde el hilo de Whisper o de la descarga: programa y no espera."""
        asyncio.run_coroutine_threadsafe(self.report(stage, fraction, message), self._loop)
