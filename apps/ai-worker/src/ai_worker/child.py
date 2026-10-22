"""Ejecución de un hijo pesado (separación de voz, identificación de hablantes) como SUBPROCESO.

Por qué un subproceso y no una llamada en el mismo proceso: Whisper (CTranslate2) y los modelos de PyTorch juntos
agotan la VRAM de una GPU normal. Un `del` más `empty_cache()` no garantiza devolver toda la memoria; que el proceso
termine sí: el sistema operativo recupera hasta el último byte (ADR 0013 y 0014).

Protocolo con el hijo: líneas `PROGRESS <etapa> <fracción>` por la salida estándar (todo lo demás se ignora); la traza
de un error va a stderr, que NUNCA llega a la persona usuaria (puede traer rutas), y el código de salida es distinto de
cero. Este módulo no conoce ningún modelo: cada tipo de hijo aporta sus etapas, su comando y sus mensajes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path

log = logging.getLogger("ai_worker")

Report = Callable[[str, float], Awaitable[None]]


class ChildFailed(Exception):
    """El hijo no completó su trabajo. El mensaje es seguro para mostrarlo: sin rutas ni trazas del hijo."""


def parse_progress(line: str, stages: frozenset[str]) -> tuple[str, float] | None:
    """`PROGRESS <etapa> <fracción>`. Cualquier otra línea (ruido de bibliotecas) o valor raro se descarta."""
    parts = line.split()
    if len(parts) != 3 or parts[0] != "PROGRESS" or parts[1] not in stages:
        return None
    try:
        fraction = float(parts[2])
    except ValueError:
        return None
    if math.isnan(fraction):
        return None
    return parts[1], min(max(fraction, 0.0), 1.0)


async def run_child(
    command: Sequence[str],
    args: Sequence[str],
    *,
    stages: frozenset[str],
    report: Report,
    stall_timeout: float,
    total_timeout: float,
    output: Path,
    label: str,
    env: Mapping[str, str] | None = None,
    redact: Sequence[str] = (),
) -> None:
    """Lanza `command + args`, relee su progreso y comprueba que escribió `output`.

    `label` es el nombre de la tarea en minúsculas («la separación de voz», «la identificación de hablantes»).
    `env` es el entorno COMPLETO del hijo (None = heredar): así los secretos viajan por entorno y no por argumentos.
    `redact` son valores (tokens) que se tachan de la traza del hijo antes de registrarla.
    Cancelar la tarea (cancelación del trabajo, apagado) mata al hijo y con él su memoria.
    """
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=None if env is None else dict(env),
        )
    except OSError as error:
        log.warning("no se pudo iniciar el subproceso (%s): %s", label, error)
        raise ChildFailed(f"No se pudo iniciar {label}.") from error

    stderr_tail = bytearray()
    stderr_task = asyncio.create_task(_drain(process.stderr, stderr_tail))
    try:
        try:
            await asyncio.wait_for(_pump(process, report, stages, stall_timeout, label), total_timeout)
        except TimeoutError as error:
            raise ChildFailed(f"{_cap(label)} tardó demasiado y se canceló.") from error
        code = await process.wait()
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
        stderr_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stderr_task

    if code != 0:
        # La traza del hijo va al log, nunca al usuario (puede traer rutas).
        trace = bytes(stderr_tail).decode(errors="replace")
        for secret in filter(None, redact):
            trace = trace.replace(secret, "***")
        log.warning("%s: el subproceso terminó con código %s: %s", label, code, trace)
        raise ChildFailed(f"{_cap(label)} falló.")
    if not output.exists():
        raise ChildFailed(f"{_cap(label)} no produjo resultado.")


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:]


async def _pump(process: asyncio.subprocess.Process, report: Report, stages: frozenset[str], stall_timeout: float, label: str) -> None:
    """Lee la salida del hijo. Si pasa `stall_timeout` sin ninguna línea, se da por colgado."""
    assert process.stdout is not None
    buffer = b""
    while True:
        try:
            chunk = await asyncio.wait_for(process.stdout.read(4096), stall_timeout)
        except TimeoutError as error:
            raise ChildFailed(f"{_cap(label)} dejó de responder y se canceló.") from error
        if not chunk:
            break
        buffer += chunk
        *lines, buffer = buffer.split(b"\n")
        buffer = buffer[-4096:]  # una "línea" sin fin no puede crecer sin límite
        for raw in lines:
            parsed = parse_progress(raw.decode(errors="replace").strip(), stages)
            if parsed is not None:
                await report(*parsed)


async def _drain(stream: asyncio.StreamReader | None, tail: bytearray) -> None:
    """Vacía stderr para que el hijo no se bloquee con la tubería llena; conserva solo el final."""
    if stream is None:
        return
    while chunk := await stream.read(4096):
        tail.extend(chunk)
        del tail[:-4096]
