"""Secretos del worker (ADR 0020): la clave externa de un espacio vive solo en memoria y nunca sale en un log, una traza ni un mensaje.

Tres piezas:
  * `Secret`: envuelve el valor. No se ve en `repr`, `str` ni f-strings, no se serializa, no se copia y se puede borrar.
  * `Redactor`: conoce los valores vivos (y sus formas escapadas) y los sustituye por `[CLAVE-OCULTA]` en cualquier texto. Además
    censura todo lo que PARECE una clave (`sk-…`, `Bearer …`) aunque nadie la haya registrado: defensa en profundidad.
  * `RedactingFilter`: se instala en los manejadores del registro raíz, así que censura también lo que registran httpx, boto3 o BullMQ.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import urllib.parse
from collections import deque
from typing import Any, NoReturn

REDACTED = "[CLAVE-OCULTA]"
_MIN_LENGTH = 8
#: Claves ya usadas (de trabajos terminados) cuyo texto se sigue censurando: una traza puede registrarse DESPUÉS de cerrar el trabajo.
_RETIRED_KEEP = 16
# Forma de una clave aunque no esté registrada: `sk-…` (OpenAI y similares) y cabeceras `Bearer …`.
_KEY_SHAPED = re.compile(r"sk-[A-Za-z0-9_\-]{16,}")
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-+/=]{16,}")


class Secret:
    """Un valor que no debe verse. Se lee con `reveal()`, solo en el punto donde se usa (la cabecera de la petición al proveedor)."""

    __slots__ = ("_value",)
    __hash__ = None  # type: ignore[assignment]  # no sirve de clave de diccionario ni de miembro de un set

    def __init__(self, value: str) -> None:
        if not isinstance(value, str):
            raise TypeError("Un secreto es un texto.")
        if value == "":
            raise ValueError("Un secreto no puede estar vacío.")
        self._value: str | None = value

    def reveal(self) -> str:
        if self._value is None:
            raise ValueError("El secreto ya se borró.")
        return self._value

    def fingerprint(self) -> str:
        """Identifica el valor sin revelarlo (para comprobar en pruebas y registros que se usó la clave correcta)."""
        return hashlib.sha256(self.reveal().encode("utf-8")).hexdigest()[:12]

    def wipe(self) -> None:
        """Suelta la referencia. Python no puede sobrescribir un `str` inmutable; esto evita usos posteriores y deja que el GC lo recoja."""
        self._value = None

    def __repr__(self) -> str:
        return "Secret(***)"

    def __str__(self) -> str:
        return "***"

    def __format__(self, format_spec: str) -> str:
        return "***"

    def __eq__(self, other: object) -> bool:
        return self is other  # comparar valores de secretos no es una operación que el código deba hacer

    def __reduce_ex__(self, protocol: Any) -> NoReturn:
        raise TypeError("Un secreto no se serializa.")

    def __copy__(self) -> NoReturn:
        raise TypeError("Un secreto no se copia.")

    def __deepcopy__(self, memo: Any) -> NoReturn:
        raise TypeError("Un secreto no se copia.")


def _variants(value: str) -> list[str]:
    """El valor tal cual y como saldría escapado en JSON, en una URL o en un `repr`."""
    found = {value, json.dumps(value)[1:-1], urllib.parse.quote(value, safe=""), repr(value)[1:-1]}
    return sorted((v for v in found if v), key=len, reverse=True)


class Redactor:
    """Registro de los valores que no pueden aparecer en ninguna salida."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._live: dict[str, list[str]] = {}
        self._retired: deque[str] = deque(maxlen=_RETIRED_KEEP)
        self._variants: list[str] = []

    def _rebuild(self) -> None:
        values = [*self._live, *self._retired]
        self._variants = sorted({variant for value in values for variant in _variants(value)}, key=len, reverse=True)

    def register(self, value: str) -> None:
        if len(value) < _MIN_LENGTH:
            raise ValueError("Un secreto tan corto desfiguraría los registros; no se registra.")
        with self._lock:
            self._live[value] = _variants(value)
            self._rebuild()

    def unregister(self, value: str) -> None:
        """Deja de censurar el valor por completo."""
        with self._lock:
            self._live.pop(value, None)
            if value in self._retired:
                self._retired.remove(value)
            self._rebuild()

    def retire(self, value: str) -> None:
        """El trabajo terminó: el valor deja de estar vivo pero se sigue censurando (las últimas 16 claves)."""
        with self._lock:
            self._live.pop(value, None)
            if value not in self._retired:
                self._retired.append(value)
            self._rebuild()

    def clear(self) -> None:
        with self._lock:
            self._live.clear()
            self._retired.clear()
            self._variants = []

    def redact(self, text: str) -> str:
        for variant in self._variants:
            if variant in text:
                text = text.replace(variant, REDACTED)
        text = _KEY_SHAPED.sub(REDACTED, text)
        return _BEARER.sub(lambda match: match.group(1) + REDACTED, text)


REDACTOR = Redactor()


class RedactingFilter(logging.Filter):
    """Censura el mensaje, los argumentos y la traza de cada registro ANTES de que lo formatee el manejador."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - un registro mal formado no debe tumbar al worker
            message = str(record.msg)
        redacted = REDACTOR.redact(message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        if record.exc_info and record.exc_info[0] is not None:
            # La traza se formatea AQUÍ para poder censurarla; sin exc_info el formateador usa exc_text tal cual.
            record.exc_text = REDACTOR.redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = REDACTOR.redact(record.exc_text)
        if record.stack_info:
            record.stack_info = REDACTOR.redact(record.stack_info)
        return True
