"""Registro del worker: texto o JSON de una línea por evento (ADR 0018), con los mismos nombres de campo que el API."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

_LEVELS = {"DEBUG": "debug", "INFO": "info", "WARNING": "warn", "ERROR": "error", "CRITICAL": "fatal"}
TEXT_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


class JsonFormatter(logging.Formatter):
    """Una línea JSON por evento. json.dumps escapa saltos de línea y comillas: un valor ajeno no puede falsificar otra línea."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": _LEVELS.get(record.levelname, record.levelname.lower()),
            "context": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(fmt: str | None = None) -> None:
    """LOG_FORMAT=json|text (por defecto text). Un valor desconocido falla al arrancar, no a mitad de un trabajo."""
    chosen = (fmt if fmt is not None else os.environ.get("LOG_FORMAT", "text")).strip().lower()
    if chosen not in ("text", "json"):
        raise ValueError(f'LOG_FORMAT debe ser text o json (recibido "{chosen}")')
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter() if chosen == "json" else logging.Formatter(TEXT_FORMAT))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
