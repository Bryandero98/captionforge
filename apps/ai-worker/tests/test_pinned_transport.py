"""Mitigación del TOCTOU/DNS rebinding (ADR 0022): la conexión TCP va a la IP que se validó, no a la que el DNS diga después.

Las pruebas de integración levantan servidores TLS reales en 127.0.0.1 / 127.0.0.2 con un certificado de `llm.example.test` (generado con
`openssl`; si no existe, se omiten): el nombre NO resuelve en ningún DNS, así que solo se puede llegar con la IP fijada. Con ellas se
comprueba que la cabecera Host y el SNI conservan el nombre, que el certificado se sigue verificando, que cada reintento vuelve a
resolver y que una redirección no lleva la clave a otro sitio."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import shutil
import ssl
import subprocess
from pathlib import Path

import httpcore
import httpx
import pytest

from ai_worker.errors import JobFailure
from ai_worker.net_guard import ResolvedTarget, assert_url_allowed
from ai_worker.pinned_transport import PinnedAsyncNetworkBackend, PinnedAsyncTransport
from ai_worker.provider_http import ProviderHttp

HOST = "llm.example.test"
KEY = "sk-clave-que-no-debe-fugarse"


def run(coro):  # noqa: ANN001, ANN201
    return asyncio.run(coro)


def resolver(*answers):  # noqa: ANN002, ANN201
    pending = list(answers)
    calls: list[str] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append(host)
        return list(pending.pop(0) if len(pending) > 1 else pending[0])

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


# ---------------------------------------------------------------------------------------------- ResolvedTarget


def test_assert_url_allowed_returns_an_immutable_resolved_target() -> None:
    target = run(assert_url_allowed(f"https://{HOST}:8443/v1", allow_private=False, resolve=resolver(["93.184.216.34"])))
    assert target == ResolvedTarget(host=HOST, port=8443, ip="93.184.216.34", scheme="https")
    with pytest.raises(dataclasses.FrozenInstanceError):
        target.ip = "10.0.0.5"  # type: ignore[misc]


def test_the_target_ip_is_one_of_the_validated_addresses_and_defaults_the_port() -> None:
    target = run(assert_url_allowed(f"https://{HOST}/v1", allow_private=False, resolve=resolver(["93.184.216.34", "8.8.8.8"])))
    assert target.ip in {"93.184.216.34", "8.8.8.8"} and target.port == 443


def test_an_ip_literal_is_its_own_target_without_dns() -> None:
    resolve = resolver(["8.8.8.8"])
    target = run(assert_url_allowed("http://127.0.0.1:11434/v1", allow_private=True, resolve=resolve))
    assert (target.host, target.ip, target.port, target.scheme) == ("127.0.0.1", "127.0.0.1", 11434, "http")
    assert resolve.calls == []


# ---------------------------------------------------------------------------------------------- backend fijado


class RecordingBackend(httpcore.AsyncNetworkBackend):
    def __init__(self) -> None:
        self.connected: list[tuple[str, int]] = []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # noqa: ANN001, ANN201
        self.connected.append((host, port))
        raise httpcore.ConnectError("sin red en esta prueba")

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):  # noqa: ANN001, ANN201
        raise AssertionError("no se usan sockets unix")

    async def sleep(self, seconds):  # noqa: ANN001, ANN201
        return None


def test_the_backend_connects_only_to_the_pinned_ip_for_the_original_host() -> None:
    inner = RecordingBackend()
    backend = PinnedAsyncNetworkBackend(ResolvedTarget(HOST, 443, "93.184.216.34", "https"), inner)
    with pytest.raises(httpcore.ConnectError):
        run(backend.connect_tcp(HOST, 443))
    assert inner.connected == [("93.184.216.34", 443)]


def test_the_backend_refuses_any_other_host_or_port_without_touching_the_network() -> None:
    inner = RecordingBackend()
    backend = PinnedAsyncNetworkBackend(ResolvedTarget(HOST, 443, "93.184.216.34", "https"), inner)
    for host, port in [("otro.example.test", 443), ("169.254.169.254", 80), (HOST, 8080)]:
        with pytest.raises(httpcore.ConnectError):
            run(backend.connect_tcp(host, port))
    assert inner.connected == []


# ---------------------------------------------------------------------------------------------- servidor TLS real

OPENSSL = shutil.which("openssl") or next((str(path) for path in [Path(r"C:\Program Files\Git\usr\bin\openssl.exe")] if path.exists()), None)
needs_openssl = pytest.mark.skipif(OPENSSL is None, reason="no hay openssl para generar el certificado de prueba")


def make_certificate(folder: Path, name: str) -> tuple[Path, Path]:
    cert, key = folder / f"{name}.pem", folder / f"{name}.key"
    subprocess.run(
        [OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1",
         "-subj", f"/CN={name}", "-addext", f"subjectAltName=DNS:{name}"],
        check=True, capture_output=True,
    )  # fmt: skip
    return cert, key


class Server:
    """HTTPS mínimo que anota lo que recibe: cabeceras, SNI y cuerpo."""

    def __init__(self, cert: Path, key: Path, status: int = 200, headers: dict[str, str] | None = None) -> None:
        self.requests: list[dict] = []
        self.sni: list[str | None] = []
        self.status, self.extra = status, headers or {}
        self._context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._context.load_cert_chain(cert, key)
        self._context.sni_callback = self._on_sni  # type: ignore[assignment]
        self._servers: list[asyncio.AbstractServer] = []

    def _on_sni(self, sock, name, context):  # noqa: ANN001, ANN202
        self.sni.append(name)

    async def start(self, address: str, port: int = 0) -> int:
        server = await asyncio.start_server(self._handle, address, port, ssl=self._context)
        self._servers.append(server)
        return server.sockets[0].getsockname()[1]

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode().split("\r\n")
            headers = {line.split(":", 1)[0].lower(): line.split(":", 1)[1].strip() for line in lines[1:] if ":" in line}
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            self.requests.append({"line": lines[0], "headers": headers, "body": body})
            payload = json.dumps({"ok": True}).encode()
            extra = "".join(f"{k}: {v}\r\n" for k, v in self.extra.items())
            writer.write(f"HTTP/1.1 {self.status} X\r\ncontent-type: application/json\r\ncontent-length: {len(payload)}\r\nconnection: close\r\n{extra}\r\n".encode() + payload)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, ssl.SSLError):
            pass
        finally:
            writer.close()

    async def stop(self) -> None:
        for server in self._servers:
            server.close()
            await server.wait_closed()


def client_context(cert: Path) -> ssl.SSLContext:
    return ssl.create_default_context(cafile=str(cert))


def provider(port: int, trust: Path, resolve, *, allow_private: bool = True, sleep=None) -> ProviderHttp:  # noqa: ANN001
    async def no_sleep(_: float) -> None:
        return None

    async def target():  # noqa: ANN202
        return await assert_url_allowed(f"https://{HOST}:{port}/v1", allow_private=allow_private, resolve=resolve)

    return ProviderHttp(f"https://{HOST}:{port}", {"authorization": f"Bearer {KEY}"}, target=target, ssl_context=client_context(trust), sleep=sleep or no_sleep)


@needs_openssl
def test_it_reaches_the_pinned_ip_keeping_host_and_sni_with_the_original_name(tmp_path: Path) -> None:
    cert, key = make_certificate(tmp_path, HOST)

    async def go() -> tuple[Server, httpx.Response]:
        server = Server(cert, key)
        port = await server.start("127.0.0.1")
        try:
            # El nombre no resuelve en ningún DNS: solo se llega a 127.0.0.1 porque la conexión va a la IP fijada.
            response = await provider(port, cert, resolver(["127.0.0.1"])).post_json("/v1/chat/completions", {"hola": 1})
            return server, response
        finally:
            await server.stop()

    server, response = run(go())
    assert response.status_code == 200
    assert server.sni == [HOST], "el SNI es el nombre original, no la IP"
    sent = server.requests[0]
    assert sent["headers"]["host"].startswith(HOST) and "127.0.0.1" not in sent["headers"]["host"]
    assert sent["line"].startswith("POST /v1/chat/completions")
    assert sent["headers"]["authorization"] == f"Bearer {KEY}"


@needs_openssl
def test_the_certificate_is_still_verified_against_the_original_name(tmp_path: Path) -> None:
    other_cert, other_key = make_certificate(tmp_path, "impostor.example.test")
    trusted, _ = make_certificate(tmp_path, HOST)

    async def go() -> Server:
        server = Server(other_cert, other_key)  # el servidor presenta un certificado de otro nombre
        port = await server.start("127.0.0.1")
        try:
            await provider(port, trusted, resolver(["127.0.0.1"])).post_json("/x", {})
        finally:
            await server.stop()
        return server

    with pytest.raises(JobFailure) as caught:
        run(go())
    assert caught.value.code == "EXTERNAL_UNAVAILABLE" and KEY not in caught.value.message


@needs_openssl
def test_every_retry_resolves_again_and_connects_to_the_new_validated_ip(tmp_path: Path) -> None:
    cert, key = make_certificate(tmp_path, HOST)

    async def go() -> tuple[Server, Server, object]:
        first, second = Server(cert, key, status=503), Server(cert, key)
        port = await first.start("127.0.0.1")
        await second.start("127.0.0.2", port)
        resolve = resolver(["127.0.0.1"], ["127.0.0.2"])
        try:
            response = await provider(port, cert, resolve).post_json("/x", {})
            assert response.status_code == 200
            return first, second, resolve
        finally:
            await first.stop()
            await second.stop()

    first, second, resolve = run(go())
    assert len(first.requests) == 1 and len(second.requests) == 1, "el reintento fue a la IP nueva, sin reutilizar la conexión vieja"
    assert resolve.calls == [HOST, HOST]


@needs_openssl
def test_a_retry_that_now_resolves_to_a_forbidden_address_never_connects(tmp_path: Path) -> None:
    cert, key = make_certificate(tmp_path, HOST)

    async def go() -> Server:
        server = Server(cert, key, status=503)
        port = await server.start("127.0.0.1")
        try:
            await provider(port, cert, resolver(["127.0.0.1"], ["169.254.169.254"])).post_json("/x", {})
        finally:
            await server.stop()
        return server

    # Primer intento: 503 (se reintenta). Segundo: el DNS "cambió" a metadatos de nube -> se aborta antes de conectar y de enviar la clave.
    server_holder: list[Server] = []

    async def wrapper() -> None:
        server_holder.append(await go())

    with pytest.raises(JobFailure) as caught:
        run(wrapper())
    assert caught.value.code == "EXTERNAL_UNAVAILABLE"


@needs_openssl
def test_a_redirect_is_not_followed_and_the_key_goes_nowhere_else(tmp_path: Path) -> None:
    cert, key = make_certificate(tmp_path, HOST)

    async def go() -> tuple[Server, Server]:
        elsewhere = Server(cert, key)
        other_port = await elsewhere.start("127.0.0.2")
        redirecting = Server(cert, key, status=302, headers={"location": f"https://{HOST}:{other_port}/robo"})
        port = await redirecting.start("127.0.0.1")
        try:
            with pytest.raises(JobFailure):
                await provider(port, cert, resolver(["127.0.0.1"])).post_json("/x", {})
        finally:
            await redirecting.stop()
            await elsewhere.stop()
        return redirecting, elsewhere

    redirecting, elsewhere = run(go())
    assert len(redirecting.requests) == 1
    assert elsewhere.requests == [] and elsewhere.sni == [], "ni siquiera se abrió conexión con el destino de la redirección"


@needs_openssl
def test_the_transport_can_be_used_directly_and_closes_cleanly(tmp_path: Path) -> None:
    cert, key = make_certificate(tmp_path, HOST)

    async def go() -> int:
        server = Server(cert, key)
        port = await server.start("127.0.0.1")
        try:
            transport = PinnedAsyncTransport(ResolvedTarget(HOST, port, "127.0.0.1", "https"), ssl_context=client_context(cert))
            async with httpx.AsyncClient(transport=transport, base_url=f"https://{HOST}:{port}") as client:
                return (await client.get("/ping")).status_code
        finally:
            await server.stop()

    assert run(go()) == 200


def test_transport_errors_are_mapped_to_httpx_exceptions() -> None:
    """ProviderHttp solo atrapa httpx.HTTPError: una excepción de httpcore sin traducir saldría como error interno con datos de la petición."""

    async def go() -> None:
        transport = PinnedAsyncTransport(ResolvedTarget(HOST, 9, "127.0.0.1", "http"))  # el puerto 9 (discard) está cerrado
        async with httpx.AsyncClient(transport=transport, base_url=f"http://{HOST}:9") as client:
            await client.get("/")

    with pytest.raises(httpx.ConnectError):
        run(go())
