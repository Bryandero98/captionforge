"""Adaptadores de proveedor (ADR 0020): traducción y voz.

El trabajo (`TranslateRunner`, `DubRunner`) solo conoce dos interfaces mínimas, `Translator` y `Voice`; de dónde sale cada una
(Argos local, OpenAI, ElevenLabs) se decide aquí. Los proveedores externos usan la clave del espacio, que se pide al API en el
último momento (`ExternalKeyClient.lease`) y solo vive en memoria mientras dura el trabajo.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Mapping
from typing import Protocol

from .errors import JobFailure
from .external_key import ExternalKeyClient

log = logging.getLogger("ai_worker")


class Translator(Protocol):
    async def translate(self, texts: list[str], source: str, target: str) -> list[str]:
        """Traduce `texts` (en orden, uno a uno). Devuelve exactamente una cadena por cada entrada."""
        ...


class ArgosTranslator:
    """Traducción local y sin conexión (Argos): ni clave ni coste. La primera vez que se pide un par, descarga su modelo."""

    async def translate(self, texts: list[str], source: str, target: str) -> list[str]:
        return await asyncio.to_thread(self._translate, texts, source, target)

    @staticmethod
    def _translate(texts: list[str], source: str, target: str) -> list[str]:
        # El módulo heredado fija ARGOS_COMPUTE_TYPE=float32 al importarse (cuantizado produce basura sin avisar).
        from captionforge import translate as legacy

        legacy._ensure_language_pair_installed(source, target)  # noqa: SLF001
        translation = legacy._get_translation(source, target)  # noqa: SLF001
        if translation is None:
            raise JobFailure("INTERNAL", "No se pudo cargar el modelo de traducción local.")
        return [translation.translate(text) for text in texts]


class Adapters:
    """Fábrica de adaptadores. `translators` permite inyectar uno por proveedor (pruebas con proveedores falsos)."""

    def __init__(
        self,
        external_keys: ExternalKeyClient | None,
        *,
        translators: Mapping[str, Translator] | None = None,
    ) -> None:
        self._external_keys = external_keys
        self._translators = dict(translators or {})

    @contextlib.asynccontextmanager
    async def translator(self, provider: str, job_id: str) -> AsyncIterator[Translator]:
        injected = self._translators.get(provider)
        if injected is not None:
            yield injected
            return
        if provider == "argos":
            yield ArgosTranslator()
            return
        raise JobFailure("INTERNAL", "El proveedor de traducción no está disponible en este worker.")
