"""Guardia de destino para la URL base propia de un proveedor (ADR 0022).

La clave del espacio solo puede viajar a un servidor que la persona eligió, y nunca a la red interna del despliegue. El API ya valida
la URL al guardarla; aquí se vuelve a comprobar **justo antes de cada petición** (también de cada reintento), resolviendo el DNS:
un nombre con aspecto público puede apuntar a una IP privada, o cambiar de respuesta entre una consulta y otra (DNS rebinding).

- `public`: dirección de Internet. Siempre permitida.
- `private`: red local (bucle, RFC 1918, CGNAT, local única). Solo con ALLOW_PRIVATE_BASE_URLS (Ollama, vLLM).
- `forbidden`: metadatos de nube y enlace local (169.254/16, fe80::/10), sin especificar, multidifusión, reservadas, IPv4 mapeada en IPv6.
  Nunca, ni con la bandera.

`assert_url_allowed` devuelve un `ResolvedTarget` inmutable (host, puerto, IP validada, esquema) y `pinned_transport` conecta SOLO a esa IP, conservando
Host, SNI y verificación del certificado del nombre original: entre la comprobación y la conexión no hay una segunda resolución que un DNS malicioso
pueda cambiar (cierre del TOCTOU / DNS rebinding).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

from .errors import JobFailure

AddressClass = Literal["public", "private", "forbidden"]
#: Resuelve un nombre a sus direcciones (texto). Se inyecta en las pruebas.
Resolver = Callable[[str, int], Awaitable[list[str]]]

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_LINK_LOCAL_V4 = ipaddress.ip_network("169.254.0.0/16")
_ULA = ipaddress.ip_network("fc00::/7")
_RFC1918 = tuple(ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_MESSAGE = (
    "La URL base de tu proveedor apunta a una red no permitida y el trabajo se canceló antes de enviar la clave. "
    "Revisa la URL en Claves externas."
)


def classify_address(address: str) -> AddressClass:
    """Clasifica una dirección IP. Cualquier texto que no sea una IP es `forbidden`."""
    try:
        ip = ipaddress.ip_address(address.split("%")[0])
    except ValueError:
        return "forbidden"
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None or ip.sixtofour is not None or ip.teredo is not None:
            return "forbidden"  # llevan una IPv4 dentro: no se confía en ellas
        if ip.is_unspecified or ip.is_multicast or ip.is_link_local:
            return "forbidden"
        if ip.is_loopback or ip in _ULA:
            return "private"
        return "public" if ip.is_global else "forbidden"  # documentación, NAT64, reservadas...
    if ip.is_unspecified or ip.is_multicast or ip.is_reserved or ip in _LINK_LOCAL_V4:
        return "forbidden"  # incluye 255.255.255.255 y los metadatos de nube
    if ip.is_loopback or ip in _CGNAT or any(ip in network for network in _RFC1918):
        return "private"
    return "public" if ip.is_global else "forbidden"  # TEST-NET, pruebas de rendimiento, protocolo IETF...


async def system_resolver(host: str, port: int) -> list[str]:
    """Resuelve con el DNS del sistema, sin bloquear el bucle de eventos."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


@dataclass(frozen=True)
class ResolvedTarget:
    """Destino ya validado: `ip` es una de las direcciones comprobadas para `host`; la conexión debe abrirse contra ella y no contra el nombre."""

    host: str
    port: int
    ip: str
    scheme: str


def _abort() -> JobFailure:
    return JobFailure("EXTERNAL_UNAVAILABLE", _MESSAGE)


def _split(url: str) -> tuple[str, str, int]:
    """(esquema, host, puerto) de una URL base. Sin credenciales, consulta ni fragmento. No repite el valor en los errores."""
    try:
        parts = urlsplit(url.strip()) if isinstance(url, str) else None
        host = parts.hostname if parts is not None else None
        port = parts.port if parts is not None else None
    except ValueError:
        raise _abort() from None
    if parts is None or parts.scheme not in ("http", "https") or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise _abort()
    return parts.scheme, host, port or (443 if parts.scheme == "https" else 80)


async def assert_url_allowed(url: str, *, allow_private: bool, resolve: Resolver = system_resolver) -> ResolvedTarget:
    """Lanza `JobFailure` (EXTERNAL_UNAVAILABLE, sin repetir la URL) si algún destino de `url` no está permitido; si todo está bien, devuelve el destino fijado."""
    scheme, host, port = _split(url)
    try:
        ipaddress.ip_address(host)
        addresses = [host]  # una IP literal no necesita DNS
    except ValueError:
        try:
            addresses = await resolve(host, port)
        except (OSError, asyncio.TimeoutError):
            raise _abort() from None
    if not addresses:
        raise _abort()
    classes = {classify_address(address) for address in addresses}
    # Basta una respuesta no permitida para abortar: un atacante puede mezclar direcciones públicas y privadas.
    if "forbidden" in classes or ("private" in classes and not allow_private):
        raise _abort()
    # Sin cifrar solo hacia la red local: un servidor público exige https.
    if scheme == "http" and classes != {"private"}:
        raise _abort()
    return ResolvedTarget(host=host, port=port, ip=addresses[0], scheme=scheme)
