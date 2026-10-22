"""Aislamiento de la voz (Demucs) antes de transcribir, en un SUBPROCESO.

Por qué un subproceso y no una llamada en el mismo proceso: Whisper (CTranslate2) y Demucs (PyTorch) juntos
agotan la VRAM de una GPU normal. Un `del` más `empty_cache()` no garantiza devolver toda la memoria; que el proceso
termine sí: el sistema operativo recupera hasta el último byte. Así el orden "soltar Whisper -> separar -> recargar
Whisper" es seguro por construcción (ADR 0013). Además `torch` y `demucs` solo se importan en el hijo: el worker no
depende de ellos, es un extra opcional (`pip install .[separation]`).

Si la separación falla, quien llama continúa con el audio original (respaldo); aquí solo se informa del fallo.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Protocol

from .child import ChildFailed, Report, run_child

log = logging.getLogger("ai_worker")

# Etapas que el hijo puede anunciar (las mismas del contrato).
SEPARATION_STAGES = frozenset({"downloading_separation_model", "separating_voice"})


class SeparationFailed(Exception):
    """La separación no se pudo completar. El mensaje es seguro para mostrarlo: sin rutas ni trazas del hijo."""


class Separator(Protocol):
    async def separate(self, source: Path, target: Path, report: Report) -> None:
        """Escribe en `target` la voz aislada de `source`. `report(etapa, fracción)` informa del avance."""
        ...


class SubprocessSeparator:
    """Lanza `python -m ai_worker.separate_cli <entrada> <salida>` y lee su progreso por la salida estándar."""

    def __init__(
        self,
        command: list[str] | None = None,
        stall_timeout: float = 300.0,
        total_timeout: float = 3600.0,
    ) -> None:
        self._command = command or [sys.executable, "-m", "ai_worker.separate_cli"]
        self._stall = stall_timeout
        self._total = total_timeout

    async def separate(self, source: Path, target: Path, report: Report) -> None:
        try:
            await run_child(
                self._command,
                [str(source), str(target)],
                stages=SEPARATION_STAGES,
                report=report,
                stall_timeout=self._stall,
                total_timeout=self._total,
                output=target,
                label="la separación de voz",
            )
        except ChildFailed as error:
            raise SeparationFailed(str(error)) from error
