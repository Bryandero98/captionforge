"""Errores del trabajo con códigos del contrato (job-error.v1)."""

from __future__ import annotations

import errno
import logging

from captionforge.models import InsufficientDiskSpaceError
from captionforge.pipeline import FfmpegTimeoutError
from captionforge.waveform import WaveformExtractionError

from .redaction import REDACTOR
from .storage import ObjectNotFound

log = logging.getLogger("ai_worker")


class JobFailure(Exception):
    """Fallo con código del contrato. `message` es para la persona usuaria: sin rutas ni secretos."""

    def __init__(self, code: str, message: str) -> None:
        # El mensaje se guarda en PostgreSQL y se muestra a la persona: una clave externa (p. ej. dentro del error de un proveedor) no puede llegar ahí.
        message = REDACTOR.redact(message)
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class JobCancelled(Exception):
    """El API pidió abortar el trabajo."""


def classify(error: BaseException) -> JobFailure:
    """Convierte cualquier excepción en un JobFailure. El detalle técnico va al log, no al usuario."""
    if isinstance(error, JobFailure):
        return error
    if isinstance(error, FfmpegTimeoutError):
        return JobFailure("FFMPEG_TIMEOUT", "ffmpeg superó el tiempo máximo y se canceló.")
    if isinstance(error, InsufficientDiskSpaceError):
        return JobFailure("OUT_OF_DISK", "No hay espacio en disco para el modelo de transcripción.")
    if isinstance(error, ObjectNotFound):
        return JobFailure("INPUT_NOT_FOUND", "El video de entrada ya no está disponible.")
    if isinstance(error, OSError) and error.errno == errno.ENOSPC:
        return JobFailure("OUT_OF_DISK", "No hay espacio en disco para procesar el video.")
    if isinstance(error, WaveformExtractionError):
        return JobFailure("FFMPEG_FAILED", "No se pudo leer el audio del video.")
    if isinstance(error, RuntimeError) and str(error).startswith("ffmpeg"):
        log.error("ffmpeg falló: %s", error)
        return JobFailure("FFMPEG_FAILED", "ffmpeg no pudo procesar el video.")
    log.error("error inesperado", exc_info=error)
    return JobFailure("INTERNAL", "Error interno del worker.")
