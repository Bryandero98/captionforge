"""Progreso del trabajo: lo escribe en PostgreSQL (fuente de verdad del API) y en BullMQ."""

from __future__ import annotations

import asyncio
import logging
import time
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
    ) -> None:
        self._repo = repo
        self._job_id = job_id
        self._loop = loop
        self._sink = sink
        self._min_interval = min_interval
        self._last_stage: str | None = None
        self._last_at = 0.0
        self._last_percent = 0.0

    @staticmethod
    def scale(stage: str, fraction: float) -> float:
        low, high = STAGE_RANGES[stage]
        return low + (high - low) * min(max(fraction, 0.0), 1.0)

    async def report(self, stage: str, fraction: float, message: str) -> None:
        """`fraction` es el avance (0-1) DENTRO de la etapa."""
        now = time.monotonic()
        if stage == self._last_stage and now - self._last_at < self._min_interval:
            return
        percent = max(self.scale(stage, fraction), self._last_percent)  # nunca retrocede
        self._last_stage, self._last_at, self._last_percent = stage, now, percent
        try:
            await self._repo.report(self._job_id, stage, round(percent, 1), message)
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
