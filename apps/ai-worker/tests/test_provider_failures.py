"""Degradación elegante frente a proveedores externos (ADR 0020, T8): servidor HTTP falso REAL con los modos de fallo.

Cada fallo del proveedor se traduce a un código EXTERNAL_* con un mensaje propio: el texto del proveedor (que puede repetir la clave,
como "Incorrect API key provided: sk-…") jamás llega al usuario ni a los registros.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from ai_worker.errors import JobFailure
from ai_worker.provider_http import ProviderHttp, parse_json
from ai_worker.redaction import REDACTOR

KEY = "sk-canario-0f3a9c71d2b84e65a1c0f7d39b2e8a46"


class Script:
    """Respuestas del servidor falso, en orden; la última se repite. ("hang", ...) no responde hasta cerrar."""

    def __init__(self, *steps: tuple[int | str, dict[str, str], bytes]) -> None:
        self.steps = list(steps)
        self.requests: list[dict] = []
        self.closing = threading.Event()

    def next(self) -> tuple[int | str, dict[str, str], bytes]:
        return self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]


def reply(status: int, body: object = None, **headers: str) -> tuple[int, dict[str, str], bytes]:
    raw = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    return status, {"content-type": "application/json", **headers}, raw


@pytest.fixture
def fake():
    script_holder: dict[str, Script] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            script = script_holder["script"]
            length = int(self.headers.get("content-length", 0))
            script.requests.append({"path": self.path, "headers": dict(self.headers), "body": self.rfile.read(length)})
            status, headers, body = script.next()
            if status == "hang":
                script.closing.wait(5)
                return
            self.send_response(int(status))
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:  # silencio
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def use(*steps) -> tuple[str, Script]:  # noqa: ANN002
        script = Script(*steps)
        script_holder["script"] = script
        return f"http://127.0.0.1:{server.server_address[1]}", script

    yield use
    for script in script_holder.values():
        script.closing.set()
    server.shutdown()
    server.server_close()


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def call(base_url: str, clock: Clock | None = None, **kwargs):  # noqa: ANN003
    clock = clock or Clock()
    http = ProviderHttp(base_url, {"authorization": f"Bearer {KEY}"}, sleep=clock.sleep, clock=clock.monotonic, **kwargs)
    return asyncio.run(http.post_json("/v1/x", {"hola": 1})), clock


def fails(base_url: str, clock: Clock | None = None, **kwargs) -> tuple[JobFailure, Clock]:  # noqa: ANN003
    clock = clock or Clock()
    with pytest.raises(JobFailure) as caught:
        call(base_url, clock, **kwargs)
    return caught.value, clock


@pytest.fixture(autouse=True)
def _registered():
    REDACTOR.clear()
    REDACTOR.register(KEY)
    yield
    REDACTOR.clear()


class TestHappyPath:
    def test_sends_the_key_in_the_header_and_returns_the_response(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(200, {"ok": True}))
        (response, _), = [call(url)]
        assert response.status_code == 200 and parse_json(response) == {"ok": True}
        [request] = script.requests
        assert request["headers"]["authorization"] == f"Bearer {KEY}"
        assert json.loads(request["body"]) == {"hola": 1}


class TestFailFast:
    @pytest.mark.parametrize(("status", "code"), [(401, "EXTERNAL_AUTH_FAILED"), (403, "EXTERNAL_AUTH_FAILED"), (402, "EXTERNAL_QUOTA_EXCEEDED")])
    def test_credentials_and_balance_are_not_retried(self, fake, status: int, code: str) -> None:  # noqa: ANN001
        url, script = fake(reply(status, {"error": {"message": f"Incorrect API key provided: {KEY}."}}))
        failure, clock = fails(url)
        assert failure.code == code
        assert len(script.requests) == 1 and clock.sleeps == []

    def test_openai_429_insufficient_quota_is_a_balance_problem_not_a_rate_limit(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(429, {"error": {"code": "insufficient_quota", "message": "You exceeded your current quota"}}))
        failure, _ = fails(url)
        assert failure.code == "EXTERNAL_QUOTA_EXCEEDED" and len(script.requests) == 1

    def test_elevenlabs_quota_exceeded_arrives_as_401_with_a_detail_status(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(401, {"detail": {"status": "quota_exceeded", "message": "no credits"}}))
        failure, _ = fails(url)
        assert failure.code == "EXTERNAL_QUOTA_EXCEEDED" and len(script.requests) == 1

    @pytest.mark.parametrize("status", [400, 404, 413, 422])
    def test_requests_the_provider_cannot_process_are_not_retried(self, fake, status: int) -> None:  # noqa: ANN001
        url, script = fake(reply(status, {"error": "bad"}))
        failure, _ = fails(url)
        assert failure.code == "EXTERNAL_UNAVAILABLE" and len(script.requests) == 1


class TestRetries:
    def test_429_waits_the_retry_after_and_then_succeeds(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(429, {"error": {"code": "rate_limit_exceeded"}}, **{"retry-after": "2"}), reply(200, {"ok": 1}))
        (response, clock), = [call(url)]
        assert response.status_code == 200 and clock.sleeps == [2.0] and len(script.requests) == 2

    def test_429_without_retry_after_backs_off_exponentially_and_ends_rate_limited(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(429, {"error": {"code": "rate_limit_exceeded"}}))
        failure, clock = fails(url)
        assert failure.code == "EXTERNAL_RATE_LIMITED"
        assert len(script.requests) == 4  # 1 + 3 reintentos
        assert clock.sleeps == [1.0, 2.0, 4.0]

    def test_a_huge_retry_after_is_clamped(self, fake) -> None:  # noqa: ANN001
        url, _ = fake(reply(429, None, **{"retry-after": "86400"}), reply(200, {"ok": 1}))
        (_, clock), = [call(url)]
        assert clock.sleeps and clock.sleeps[0] <= 30.0

    @pytest.mark.parametrize("status", [500, 502, 503, 504])
    def test_5xx_is_retried_with_backoff_and_ends_unavailable(self, fake, status: int) -> None:  # noqa: ANN001
        url, script = fake(reply(status, {"error": "boom"}))
        failure, clock = fails(url)
        assert failure.code == "EXTERNAL_UNAVAILABLE" and len(script.requests) == 4 and clock.sleeps == [1.0, 2.0, 4.0]

    def test_a_transient_5xx_recovers(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(503), reply(200, {"ok": 1}))
        (response, _), = [call(url)]
        assert response.status_code == 200 and len(script.requests) == 2

    def test_the_total_time_budget_stops_the_retries_early(self, fake) -> None:  # noqa: ANN001
        url, script = fake(reply(500))
        failure, _ = fails(url, total_timeout=2.5)
        assert failure.code == "EXTERNAL_UNAVAILABLE"
        assert len(script.requests) < 4, "no se sigue reintentando pasado el tope de tiempo total"


class TestTimeoutsAndBrokenReplies:
    def test_a_provider_that_never_answers_ends_in_external_timeout(self, fake) -> None:  # noqa: ANN001
        url, script = fake(("hang", {}, b""))
        failure, _ = fails(url, read_timeout=0.2)
        assert failure.code == "EXTERNAL_TIMEOUT"
        assert len(script.requests) >= 1

    def test_a_network_cut_is_retried_and_ends_unavailable(self) -> None:
        import httpx

        attempts: list[int] = []

        def cut(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ConnectError("sin ruta")

        clock = Clock()
        http = ProviderHttp("http://proveedor.invalido", {"authorization": f"Bearer {KEY}"}, transport=httpx.MockTransport(cut), sleep=clock.sleep, clock=clock.monotonic)
        with pytest.raises(JobFailure) as caught:
            asyncio.run(http.post_json("/v1/x", {}))
        assert caught.value.code == "EXTERNAL_UNAVAILABLE" and len(attempts) == 4 and clock.sleeps == [1.0, 2.0, 4.0]

    def test_broken_json_in_a_200_is_unavailable(self, fake) -> None:  # noqa: ANN001
        url, _ = fake(reply(200, b"<html>gateway ok</html>"))
        (response, _), = [call(url)]
        with pytest.raises(JobFailure) as caught:
            parse_json(response)
        assert caught.value.code == "EXTERNAL_UNAVAILABLE"

    def test_redirects_are_not_followed_so_the_key_is_never_sent_elsewhere(self, fake) -> None:  # noqa: ANN001
        url, script = fake((302, {"location": "http://atacante.example/robar"}, b""))
        failure, _ = fails(url)
        assert failure.code == "EXTERNAL_UNAVAILABLE" and len(script.requests) == 1


class TestNothingFromTheProviderReachesTheUser:
    @pytest.mark.parametrize("status", [401, 402, 429, 500, 400])
    def test_messages_and_logs_never_carry_provider_text_or_the_key(self, fake, status: int, caplog: pytest.LogCaptureFixture) -> None:  # noqa: ANN001
        provider_text = f"Incorrect API key provided: {KEY}. TEXTO-DEL-PROVEEDOR"
        url, _ = fake(reply(status, {"error": {"message": provider_text}}))
        caplog.set_level(logging.DEBUG)
        failure, _ = fails(url)
        everything = f"{failure.message} {failure} {failure!r} {caplog.text}"
        assert "TEXTO-DEL-PROVEEDOR" not in everything
        assert KEY not in everything and KEY[3:25] not in everything
        assert failure.__cause__ is None and failure.__suppress_context__ is True
        assert 0 < len(failure.message) <= 200, "mensaje corto y propio, en español"
