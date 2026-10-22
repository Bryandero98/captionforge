"""Aislamiento de la voz (Demucs) antes de transcribir, en un SUBPROCESO.

Por qué un subproceso y no una llamada en el mismo proceso: Whisper (CTranslate2) y Demucs (PyTorch) juntos
agotan la VRAM de una GPU normal. Un `del` más `empty_cache()` no garantiza devolver toda la memoria; que el proceso
termine sí: el sistema operativo recupera hasta el último byte. Así el orden "soltar Whisper -> separar -> recargar
Whisper" es seguro por construcción (ADR 0013). Además `torch` y `demucs` solo se importan en el hijo: el worker no
depende de ellos, es un extra opcional (`pip install .[separation]`).

Si la separación falla, quien llama continúa con el audio original (respaldo); aquí solo se informa del fallo.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Protocol

log = logging.getLogger("ai_worker")

# Etapas que el hijo puede anunciar (las mismas del contrato).
SEPARATION_STAGES = frozenset({"downloading_separation_model", "separating_voice"})

Report = Callable[[str, float], Awaitable[None]]


class SeparationFailed(Exception):
    """La separación no se pudo completar. El mensaje es seguro para mostrarlo: sin rutas ni trazas del hijo."""


class Separator(Protocol):
    async def separate(self, source: Path, target: Path, report: Report) -> None:
        """Escribe en `target` la voz aislada de `source`. `report(etapa, fracción)` informa del avance."""
        ...


def _parse_progress(line: str) -> tuple[str, float] | None:
    """`PROGRESS <etapa> <fracción>`. Cualquier otra línea (ruido de bibliotecas) o valor raro se descarta."""
    parts = line.split()
    if len(parts) != 3 or parts[0] != "PROGRESS" or parts[1] not in SEPARATION_STAGES:
        return None
    try:
        fraction = float(parts[2])
    except ValueError:
        return None
    if math.isnan(fraction):
        return None
    return parts[1], min(max(fraction, 0.0), 1.0)


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
            process = await asyncio.create_subprocess_exec(
                *self._command,
                str(source),
                str(target),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            log.warning("no se pudo iniciar el separador de voz: %s", error)
            raise SeparationFailed("No se pudo iniciar la separación de voz.") from error

        stderr_tail = bytearray()
        stderr_task = asyncio.create_task(self._drain(process.stderr, stderr_tail))
        try:
            try:
                await asyncio.wait_for(self._pump(process, report), self._total)
            except TimeoutError as error:
                raise SeparationFailed("La separación de voz tardó demasiado y se canceló.") from error
            code = await process.wait()
        finally:
            # Cancelar la tarea (cancelación del trabajo, apagado) o cualquier fallo: el hijo muere y con él su memoria.
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
            stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_task

        if code != 0:
            # La traza del hijo va al log, nunca al usuario (puede traer rutas).
            log.warning("el separador de voz terminó con código %s: %s", code, bytes(stderr_tail).decode(errors="replace"))
            raise SeparationFailed("La separación de voz falló.")
        if not target.exists():
            raise SeparationFailed("La separación de voz no produjo audio.")

    async def _pump(self, process: asyncio.subprocess.Process, report: Report) -> None:
        """Lee la salida del hijo. Si pasa `stall_timeout` sin ninguna línea, se da por colgado."""
        assert process.stdout is not None
        buffer = b""
        while True:
            try:
                chunk = await asyncio.wait_for(process.stdout.read(4096), self._stall)
            except TimeoutError as error:
                raise SeparationFailed("La separación de voz dejó de responder y se canceló.") from error
            if not chunk:
                break
            buffer += chunk
            *lines, buffer = buffer.split(b"\n")
            buffer = buffer[-4096:]  # una "línea" sin fin no puede crecer sin límite
            for raw in lines:
                parsed = _parse_progress(raw.decode(errors="replace").strip())
                if parsed is not None:
                    await report(*parsed)

    @staticmethod
    async def _drain(stream: asyncio.StreamReader | None, tail: bytearray) -> None:
        """Vacía stderr para que el hijo no se bloquee con la tubería llena; conserva solo el final."""
        if stream is None:
            return
        while chunk := await stream.read(4096):
            tail.extend(chunk)
            del tail[:-4096]
