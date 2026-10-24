"""Cliente del canal interno del API (ADR 0020): pide la clave externa de SU trabajo justo antes de usarla.

La clave nunca viaja por Redis ni por el payload del trabajo. El worker la pide por HTTP al API (red interna de Docker) con
`Authorization: Bearer <WORKER_INTERNAL_TOKEN>`; el API decide a qué espacio pertenece mirando la fila del trabajo, que debe estar
RUNNING, ser TRANSLATE o DUB y haber declarado ese proveedor. Aquí la clave queda envuelta en un `Secret`, registrada para su censura
y se borra al terminar (`lease`).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

from .redaction import REDACTOR, Secret

log = logging.getLogger("ai_worker")

MIN_TOKEN_LENGTH = 32
_MAX_KEY_LENGTH = 512
_MIN_KEY_LENGTH = 8
_MAX_BASE_URL_LENGTH = 2048
#: Mismo formato que valida el API (ADR 0022): letras, números y . _ : / @ + - (hasta 100).
_MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$")
_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (0.5, 1.5)
#: Un `Retry-After` desmesurado no debe dejar al worker esperando minutos con el hueco de ejecución tomado.
_MAX_RETRY_AFTER = 10.0
_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)


@dataclass(frozen=True)
class ExternalCredential:
    """Lo que el API entrega para un trabajo: la clave y, si el espacio los guardó, la URL base y el modelo (ADR 0022).

    `base_url` y `model` son opcionales; sin ellos se usa el host y el modelo fijos del proveedor. La URL se censura en los registros
    igual que la clave: una traza de httpx la lleva dentro."""

    secret: Secret = field(repr=False)
    base_url: str | None = None
    model: str | None = None

    def __repr__(self) -> str:
        return f"ExternalCredential(base_url={'<oculta>' if self.base_url else None}, model={self.model!r})"


class ExternalKeyError(Exception):
    """No se pudo obtener la clave. El mensaje es genérico a propósito: ni el token, ni la clave, ni el cuerpo de la respuesta.

    `reason`: unauthorized (token), not_eligible (trabajo no apto), missing (el espacio no tiene esa clave), disabled (el API no tiene
    BYOK), bad_request, unavailable, timeout, bad_response.
    """

    def __init__(self, reason: str, status: int | None = None) -> None:
        super().__init__(f"No se pudo obtener la clave externa ({reason}).")
        self.reason = reason
        self.status = status


def validate_base_url(url: str) -> str:
    """URL base http(s) sin credenciales ni ruta. Devuelve la URL sin barra final. Los mensajes no repiten el valor."""
    parts = urlsplit(url.strip()) if isinstance(url, str) else None
    if parts is None or parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("La URL del canal interno debe ser http(s)://host[:puerto].")
    if parts.username or parts.password:
        raise ValueError("La URL del canal interno no puede llevar credenciales.")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("La URL del canal interno no lleva ruta, consulta ni fragmento.")
    return f"{parts.scheme}://{parts.netloc}"


def validate_token(token: str) -> str:
    if not isinstance(token, str) or len(token) < MIN_TOKEN_LENGTH:
        raise ValueError(f"El token del canal interno debe tener al menos {MIN_TOKEN_LENGTH} caracteres.")
    return token


def _error_code(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    code = body.get("code") if isinstance(body, dict) else None
    return code if isinstance(code, str) else None


class ExternalKeyClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._base_url = validate_base_url(base_url)
        validate_token(token)
        self._token = Secret(token)
        REDACTOR.register(token)  # el token también se censura si algún día aparece en un log o una traza
        self._transport = transport
        self._sleep = sleep

    async def fetch(self, job_id: str, provider: str) -> Secret:
        """Solo la clave de `provider` del espacio al que pertenece `job_id` (la voz no usa URL base ni modelo)."""
        return (await self.fetch_credential(job_id, provider)).secret

    async def fetch_credential(self, job_id: str, provider: str) -> ExternalCredential:
        """La clave, y la URL base y el modelo si los hay. Reintenta solo lo transitorio (red, 429, 5xx)."""
        reason, status = "unavailable", None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            wait: float | None = None
            try:
                async with httpx.AsyncClient(
                    base_url=self._base_url,
                    transport=self._transport,
                    timeout=_TIMEOUT,
                    follow_redirects=False,  # el token no se reenvía a otro sitio
                    trust_env=False,  # ni proxies ni certificados del entorno
                    headers={"authorization": f"Bearer {self._token.reveal()}"},
                ) as http:
                    response = await http.post(f"/internal/v1/jobs/{job_id}/external-key", json={"provider": provider})
            except httpx.TimeoutException:
                reason, status = "timeout", None
            except httpx.HTTPError:
                reason, status = "unavailable", None
            else:
                outcome = self._interpret(response)
                if isinstance(outcome, ExternalCredential):
                    return outcome
                reason, status, retry, wait = outcome
                if not retry:
                    raise ExternalKeyError(reason, status) from None
            if attempt < _MAX_ATTEMPTS:
                delay = wait if wait is not None else _BACKOFF_SECONDS[attempt - 1]
                log.warning("no se pudo obtener la clave externa (%s); reintento %d de %d", reason, attempt, _MAX_ATTEMPTS - 1)
                await self._sleep(delay)
        raise ExternalKeyError(reason, status) from None

    def _interpret(self, response: httpx.Response) -> ExternalCredential | tuple[str, int, bool, float | None]:
        """Una respuesta es la clave o (motivo, estado, ¿reintentar?, espera). Nunca se repite su contenido en un mensaje."""
        status = response.status_code
        if status == 200:
            return self._read_key(response)
        if status == 429:
            retry_after = response.headers.get("retry-after", "")
            try:
                wait = min(max(float(retry_after), 0.0), _MAX_RETRY_AFTER)
            except ValueError:
                wait = None
            return "unavailable", status, True, wait
        if status >= 500 and status != 503:
            return "unavailable", status, True, None
        code = _error_code(response)
        if status == 503:
            return "disabled", status, False, None
        if status == 401:
            return "unauthorized", status, False, None
        if status == 403:
            return "not_eligible", status, False, None
        if status == 404:
            return ("missing" if code == "external_key_not_found" else "not_eligible"), status, False, None
        if status == 400:
            return "bad_request", status, False, None
        return "unavailable", status, False, None  # 3xx u otro estado inesperado: no se sigue ni se reintenta

    def _read_key(self, response: httpx.Response) -> ExternalCredential | tuple[str, int, bool, float | None]:
        bad = ("bad_response", response.status_code, False, None)
        try:
            body = response.json()
        except ValueError:
            return bad
        key = body.get("key") if isinstance(body, dict) else None
        if not isinstance(key, str) or not _MIN_KEY_LENGTH <= len(key) <= _MAX_KEY_LENGTH:
            return bad
        base_url, model = body.get("baseUrl"), body.get("model")
        # Ausente o null = sin valor propio. Presente pero con otra forma, la respuesta entera se descarta (nunca se adivina a dónde enviar la clave).
        if "baseUrl" in body and base_url is not None and not (isinstance(base_url, str) and 0 < len(base_url) <= _MAX_BASE_URL_LENGTH):
            return bad
        if "model" in body and model is not None and not (isinstance(model, str) and _MODEL_NAME.fullmatch(model)):
            return bad
        REDACTOR.register(key)  # desde este instante ningún log ni traza puede llevarla
        if base_url is not None:
            REDACTOR.register(base_url)
        return ExternalCredential(Secret(key), base_url, model)

    @contextlib.asynccontextmanager
    async def lease(self, job_id: str, provider: str) -> AsyncIterator[Secret]:
        """La clave durante un trabajo. Al salir (también con error) el `Secret` se borra; el texto sigue censurado un tiempo, porque
        la traza del error que se propaga puede registrarse después de salir de aquí."""
        async with self.lease_credential(job_id, provider) as credential:
            yield credential.secret

    @contextlib.asynccontextmanager
    async def lease_credential(self, job_id: str, provider: str) -> AsyncIterator[ExternalCredential]:
        """Como `lease`, pero con la URL base y el modelo del espacio si los guardó (ADR 0022)."""
        credential = await self.fetch_credential(job_id, provider)
        value = credential.secret.reveal()
        try:
            yield credential
        finally:
            REDACTOR.retire(value)
            if credential.base_url is not None:
                REDACTOR.retire(credential.base_url)
            credential.secret.wipe()
