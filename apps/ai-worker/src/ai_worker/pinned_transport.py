"""Transporte HTTP con la conexión TCP fijada a una IP ya validada (ADR 0022, cierre del TOCTOU / DNS rebinding).

`assert_url_allowed` resuelve el nombre y valida TODAS las direcciones; si dejáramos que httpx volviera a resolver el nombre al conectar, un DNS
malicioso podría contestar otra cosa entre las dos consultas. Aquí la conexión se abre contra `ResolvedTarget.ip` y nada más.

Lo único que cambia es el destino del socket. La URL, la cabecera Host, el pool de conexiones y el SNI / verificación del certificado siguen siendo los
del nombre original (httpcore usa el host del origen para `start_tls`), así que NO hace falta `verify=False` ni reescribir la URL con la IP.
Cualquier otro host o puerto se rechaza sin tocar la red: una redirección no puede llevar la conexión (ni la clave) a otro sitio.
"""

from __future__ import annotations

import ssl
from collections.abc import AsyncIterator, Iterable
from typing import Any

import httpcore
import httpx

from .net_guard import ResolvedTarget


class PinnedAsyncNetworkBackend(httpcore.AsyncNetworkBackend):
    """Abre el socket TCP contra `target.ip` cuando se pide `target.host:target.port`; rechaza cualquier otro destino."""

    def __init__(self, target: ResolvedTarget, inner: httpcore.AsyncNetworkBackend | None = None) -> None:
        self._target = target
        self._inner = inner or httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if host != self._target.host or port != self._target.port:
            raise httpcore.ConnectError("Destino distinto del validado: la conexión no se abre.")
        return await self._inner.connect_tcp(self._target.ip, port, timeout=timeout, local_address=local_address, socket_options=socket_options)

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Iterable[Any] | None = None) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("Los sockets unix no se usan con proveedores externos.")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def _exception_map() -> list[tuple[type[Exception], type[Exception]]]:
    """httpcore -> httpx, de lo más específico a lo más general. Sin esto ProviderHttp (que solo atrapa httpx.HTTPError) vería un error ajeno."""
    return [
        (httpcore.ConnectTimeout, httpx.ConnectTimeout),
        (httpcore.ReadTimeout, httpx.ReadTimeout),
        (httpcore.WriteTimeout, httpx.WriteTimeout),
        (httpcore.PoolTimeout, httpx.PoolTimeout),
        (httpcore.ConnectError, httpx.ConnectError),
        (httpcore.ReadError, httpx.ReadError),
        (httpcore.WriteError, httpx.WriteError),
        (httpcore.RemoteProtocolError, httpx.RemoteProtocolError),
        (httpcore.LocalProtocolError, httpx.LocalProtocolError),
        (httpcore.UnsupportedProtocol, httpx.UnsupportedProtocol),
        (httpcore.ProxyError, httpx.ProxyError),
        (httpcore.TimeoutException, httpx.TimeoutException),
        (httpcore.NetworkError, httpx.NetworkError),
        (httpcore.ProtocolError, httpx.ProtocolError),
    ]


def _translate(error: Exception) -> Exception:
    for source, target in _exception_map():
        if isinstance(error, source):
            return target(str(error))
    return httpx.TransportError(str(error))


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream: AsyncIterator[bytes] | Any) -> None:
        self._stream = stream

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for part in self._stream:
                yield part
        except httpcore.ConnectionNotAvailable:
            raise
        except Exception as error:  # noqa: BLE001 - se traduce a la jerarquía de httpx
            if isinstance(error, httpx.HTTPError):
                raise
            raise _translate(error) from error

    async def aclose(self) -> None:
        if hasattr(self._stream, "aclose"):
            await self._stream.aclose()


class PinnedAsyncTransport(httpx.AsyncBaseTransport):
    """Transporte de httpx sobre un pool de httpcore cuyo backend de red está fijado a `target`. Uno por intento: nada se reutiliza entre resoluciones."""

    def __init__(self, target: ResolvedTarget, *, ssl_context: ssl.SSLContext | None = None, backend: httpcore.AsyncNetworkBackend | None = None) -> None:
        self.target = target
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl_context if ssl_context is not None else httpx.create_ssl_context(),
            max_connections=10,
            max_keepalive_connections=0,  # cada intento abre su conexión: nunca queda abierta una hacia una IP ya descartada
            http1=True,
            http2=False,
            network_backend=PinnedAsyncNetworkBackend(target, backend),
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        outgoing = httpcore.Request(
            method=request.method,
            url=httpcore.URL(scheme=request.url.raw_scheme, host=request.url.raw_host, port=request.url.port, target=request.url.raw_path),
            headers=request.headers.raw,
            content=request.stream,  # type: ignore[arg-type]
            extensions=request.extensions,
        )
        try:
            response = await self._pool.handle_async_request(outgoing)
        except Exception as error:  # noqa: BLE001
            if isinstance(error, httpx.HTTPError):
                raise
            raise _translate(error) from error
        return httpx.Response(status_code=response.status, headers=response.headers, stream=_ResponseStream(response.stream), extensions=response.extensions)

    async def aclose(self) -> None:
        await self._pool.aclose()
