"""Cliente HTTP de los proveedores externos con degradación elegante (ADR 0020 §6).

Cada fallo del proveedor se traduce a un código `EXTERNAL_*` con un mensaje PROPIO, en español. El texto del proveedor no se copia a
ningún sitio: OpenAI repite fragmentos de la clave en "Incorrect API key provided: sk-…", y esos mensajes acabarían en la base y en
pantalla. Del cuerpo del error solo se lee un código corto (p. ej. `insufficient_quota`) para distinguir saldo agotado de límite de uso.

- 401/402/403: no se reintentan (la clave o el saldo no se arreglan solos).
- 429 y 5xx: hasta 3 reintentos con espera exponencial (1, 2, 4 s) o el `Retry-After` del proveedor (acotado), y con un tope de tiempo total.
- Cuelgue, corte de red o respuesta rota: se reintentan igual y terminan en EXTERNAL_TIMEOUT / EXTERNAL_UNAVAILABLE.
- Sin redirecciones ni proxies del entorno: la clave solo viaja al host configurado.
- Con `target` (URL base propia, ADR 0022) se resuelve y valida el destino ANTES de cada intento y la conexión se fija a esa IP
  (`PinnedAsyncTransport`): Host, SNI y certificado siguen siendo los del nombre original.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import httpx

from .errors import JobFailure
from .net_guard import ResolvedTarget
from .pinned_transport import PinnedAsyncTransport

log = logging.getLogger("ai_worker")

MAX_RETRIES = 3
_BACKOFF_BASE = 1.0
_MAX_RETRY_AFTER = 30.0

_MESSAGES = {
    "EXTERNAL_AUTH_FAILED": "El proveedor rechazó la clave. Revísala o reemplázala en Claves externas.",
    "EXTERNAL_QUOTA_EXCEEDED": "El proveedor indica que no hay saldo o cuota disponible. Revisa tu cuenta con el proveedor.",
    "EXTERNAL_RATE_LIMITED": "El proveedor limitó las peticiones. Vuelve a intentarlo en unos minutos.",
    "EXTERNAL_TIMEOUT": "El proveedor tardó demasiado en responder.",
    "EXTERNAL_UNAVAILABLE": "El proveedor no está disponible o respondió algo inesperado.",
    "EXTERNAL_REJECTED": "El proveedor no pudo procesar la petición.",
}
#: Peticiones que el proveedor no puede procesar: reintentar no cambia nada. Código del contrato: EXTERNAL_UNAVAILABLE.
_REJECTED_STATUSES = {400, 404, 405, 409, 410, 413, 415, 422}
_QUOTA_WORDS = ("quota", "insufficient", "billing", "credit", "balance")


def external_failure(code: str, *, rejected: bool = False) -> JobFailure:
    """Fallo con mensaje propio. `from None` en quien lo lanza: la cadena de httpx llevaría la petición con la clave."""
    message_key = "EXTERNAL_REJECTED" if rejected else code
    failure = JobFailure(code, _MESSAGES[message_key])
    failure.rejected = rejected  # type: ignore[attr-defined]  # el proveedor entendió la petición y no la acepta (4xx): reintentar igual no sirve
    return failure


def parse_json(response: httpx.Response) -> Any:
    """Cuerpo JSON de una respuesta correcta; si el proveedor devuelve otra cosa (HTML de un proxy, texto), falla de forma controlada."""
    try:
        return response.json()
    except ValueError:
        raise external_failure("EXTERNAL_UNAVAILABLE") from None


def _error_words(response: httpx.Response) -> str:
    """Solo los campos cortos que nombran la causa (error.code/type, detail.status, code). Nunca el mensaje libre."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    parts: list[Any] = [body.get("code"), body.get("type")]
    for nested in (body.get("error"), body.get("detail")):
        if isinstance(nested, dict):
            parts += [nested.get("code"), nested.get("type"), nested.get("status")]
    return " ".join(part.lower() for part in parts if isinstance(part, str))[:200]


def _is_quota(response: httpx.Response) -> bool:
    words = _error_words(response)
    return any(word in words for word in _QUOTA_WORDS)


class ProviderHttp:
    def __init__(
        self,
        base_url: str,
        headers: Mapping[str, str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        connect_timeout: float = 10.0,
        read_timeout: float = 60.0,
        total_timeout: float = 300.0,
        target: Callable[[], Awaitable[ResolvedTarget]] | None = None,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self._base_url = base_url
        self._headers = dict(headers)  # contiene la clave: no se registra ni se reexpone
        self._transport = transport
        self._sleep = sleep
        self._clock = clock
        self._timeout = httpx.Timeout(connect=connect_timeout, read=read_timeout, write=30.0, pool=connect_timeout)
        self._total_timeout = total_timeout
        #: Se espera ANTES de cada intento (también de los reintentos): resuelve, valida y devuelve el destino fijado. Si lanza, no sale ninguna
        #: petición y la clave no viaja (ADR 0022). Con un `transport` inyectado (pruebas) solo se valida; sin él, la conexión se fija a la IP.
        self._target = target
        self._ssl_context = ssl_context

    def __repr__(self) -> str:
        return f"ProviderHttp(base_url={self._base_url!r})"

    async def post_json(self, path: str, payload: Any) -> httpx.Response:
        """POST con reintentos. Devuelve la respuesta 2xx o lanza JobFailure EXTERNAL_*."""
        deadline = self._clock() + self._total_timeout
        code = "EXTERNAL_UNAVAILABLE"
        for attempt in range(MAX_RETRIES + 1):
            wait: float | None = None
            transport = self._transport
            if self._target is not None:
                resolved = await self._target()
                if transport is None:
                    transport = PinnedAsyncTransport(resolved, ssl_context=self._ssl_context)
            try:
                async with httpx.AsyncClient(
                    base_url=self._base_url,
                    headers=self._headers,
                    timeout=self._timeout,
                    transport=transport,
                    follow_redirects=False,  # la clave no se reenvía a otro sitio
                    trust_env=False,  # ni proxies ni certificados del entorno
                ) as client:
                    response = await client.post(path, json=payload)
            except httpx.TimeoutException:
                code = "EXTERNAL_TIMEOUT"
            except httpx.HTTPError:
                code = "EXTERNAL_UNAVAILABLE"
            else:
                status = response.status_code
                if 200 <= status < 300:
                    return response
                retryable, code, wait = self._classify(response)
                log.warning("el proveedor respondió %d (%s)%s", status, code, "; se reintenta" if retryable and attempt < MAX_RETRIES else "")
                if not retryable:
                    raise external_failure(code, rejected=status in _REJECTED_STATUSES) from None
            if attempt == MAX_RETRIES:
                break
            delay = wait if wait is not None else _BACKOFF_BASE * (2**attempt)
            if self._clock() + delay > deadline:
                break  # no se sigue esperando pasado el tope total
            await self._sleep(delay)
        raise external_failure(code) from None

    @staticmethod
    def _classify(response: httpx.Response) -> tuple[bool, str, float | None]:
        """(¿reintentar?, código, espera pedida por el proveedor)."""
        status = response.status_code
        if status == 402 or (status in (401, 403, 429) and _is_quota(response)):
            return False, "EXTERNAL_QUOTA_EXCEEDED", None
        if status in (401, 403):
            return False, "EXTERNAL_AUTH_FAILED", None
        if status == 429:
            try:
                wait: float | None = min(max(float(response.headers.get("retry-after", "")), 0.0), _MAX_RETRY_AFTER)
            except ValueError:
                wait = None
            return True, "EXTERNAL_RATE_LIMITED", wait
        if status >= 500:
            return True, "EXTERNAL_UNAVAILABLE", None
        return False, "EXTERNAL_UNAVAILABLE", None  # rechazos (400/404/422…) y redirecciones: reintentar no cambia nada
