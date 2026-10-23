"""Cliente del canal interno (ADR 0020): el worker pide al API la clave externa de SU trabajo, justo antes de usarla."""

from __future__ import annotations

import asyncio
import json
import uuid

import httpx
import pytest

from ai_worker.config import ConfigError, WorkerConfig
from ai_worker.external_key import ExternalKeyClient, ExternalKeyError
from ai_worker.redaction import REDACTED, REDACTOR, Secret

KEY = "sk-canario-4f9a1c7e2b8d03a6f5e1c9b7d2a48e60"
TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c"
BASE = "http://api-gateway:3100"
JOB = str(uuid.uuid4())


@pytest.fixture(autouse=True)
def _limpio():
    REDACTOR.clear()
    yield
    REDACTOR.clear()


class Server:
    """Un API interno de mentira: guarda las peticiones y responde lo que se le indique, en orden."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, Exception):
            raise item
        return item


def ok(key: str = KEY) -> httpx.Response:
    return httpx.Response(200, json={"key": key})


def reply(status: int, code: str = "x", **headers: str) -> httpx.Response:
    return httpx.Response(status, json={"statusCode": status, "code": code, "message": "m"}, headers=headers)


def client(server: Server, sleeps: list[float] | None = None, **kwargs) -> ExternalKeyClient:
    async def sleep(seconds: float) -> None:
        if sleeps is not None:
            sleeps.append(seconds)

    return ExternalKeyClient(BASE, TOKEN, transport=httpx.MockTransport(server), sleep=sleep, **kwargs)


def fetch(c: ExternalKeyClient, provider: str = "openai") -> Secret:
    return asyncio.run(c.fetch(JOB, provider))


class TestFetch:
    def test_pide_la_clave_de_su_trabajo_con_el_token_y_la_devuelve_como_secreto(self) -> None:
        server = Server(ok())
        secret = fetch(client(server))
        assert isinstance(secret, Secret)
        assert secret.reveal() == KEY
        [request] = server.requests
        assert request.method == "POST"
        assert str(request.url) == f"{BASE}/internal/v1/jobs/{JOB}/external-key"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert json.loads(request.content) == {"provider": "openai"}

    def test_la_clave_recibida_queda_registrada_para_censurarla_en_cualquier_salida(self) -> None:
        fetch(client(Server(ok())))
        assert KEY not in REDACTOR.redact(f"error con {KEY}")

    def test_el_token_del_worker_tambien_se_censura(self) -> None:
        client(Server(ok()))
        assert TOKEN not in REDACTOR.redact(f"cabecera Bearer {TOKEN}")

    @pytest.mark.parametrize(
        ("status", "code", "reason"),
        [
            (401, "unauthorized", "unauthorized"),
            (403, "job_not_running", "not_eligible"),
            (403, "provider_mismatch", "not_eligible"),
            (404, "job_not_found", "not_eligible"),
            (404, "external_key_not_found", "missing"),
            (503, "byok_disabled", "disabled"),
            (400, "invalid_provider", "bad_request"),
        ],
    )
    def test_los_errores_definitivos_no_se_reintentan(self, status: int, code: str, reason: str) -> None:
        server = Server(reply(status, code))
        with pytest.raises(ExternalKeyError) as caught:
            fetch(client(server))
        assert caught.value.reason == reason
        assert caught.value.status == status
        assert len(server.requests) == 1

    def test_429_con_retry_after_espera_y_reintenta(self) -> None:
        sleeps: list[float] = []
        server = Server(reply(429, "rate_limited", **{"retry-after": "2"}), ok())
        assert fetch(client(server, sleeps)).reveal() == KEY
        assert len(server.requests) == 2
        assert sleeps == [2.0]

    def test_un_retry_after_enorme_no_cuelga_al_worker(self) -> None:
        sleeps: list[float] = []
        server = Server(reply(429, "rate_limited", **{"retry-after": "3600"}), ok())
        fetch(client(server, sleeps))
        assert sleeps and sleeps[0] <= 10

    def test_5xx_y_cortes_de_red_se_reintentan_con_espera_creciente_y_luego_fallan(self) -> None:
        sleeps: list[float] = []
        server = Server(reply(502), httpx.ConnectError("no hay ruta"), reply(500))
        with pytest.raises(ExternalKeyError) as caught:
            fetch(client(server, sleeps))
        assert caught.value.reason == "unavailable"
        assert len(server.requests) == 3
        assert len(sleeps) == 2 and sleeps[0] < sleeps[1]

    def test_un_tiempo_agotado_es_timeout(self) -> None:
        server = Server(httpx.ReadTimeout("lento"))
        with pytest.raises(ExternalKeyError) as caught:
            fetch(client(server, []))
        assert caught.value.reason == "timeout"
        assert len(server.requests) == 3

    def test_recupera_si_un_reintento_funciona(self) -> None:
        server = Server(httpx.ConnectError("x"), ok())
        assert fetch(client(server, [])).reveal() == KEY

    @pytest.mark.parametrize(
        "response",
        [
            httpx.Response(200, text="no es json"),
            httpx.Response(200, json=["key"]),
            httpx.Response(200, json={}),
            httpx.Response(200, json={"key": ""}),
            httpx.Response(200, json={"key": 7}),
            httpx.Response(200, json={"key": "x" * 5000}),
        ],
    )
    def test_una_respuesta_mal_formada_es_bad_response_sin_repetir_su_contenido(self, response: httpx.Response) -> None:
        with pytest.raises(ExternalKeyError) as caught:
            fetch(client(Server(response)))
        assert caught.value.reason == "bad_response"
        assert "no es json" not in str(caught.value)

    def test_los_mensajes_de_error_nunca_llevan_el_token_ni_la_clave(self) -> None:
        for response in (reply(401, "unauthorized"), reply(404, "external_key_not_found"), httpx.Response(200, text=KEY)):
            with pytest.raises(ExternalKeyError) as caught:
                fetch(client(Server(response)))
            text = f"{caught.value} {caught.value!r} {caught.value.args}"
            assert TOKEN not in text
            assert KEY not in text

    def test_la_cadena_de_excepciones_no_arrastra_la_peticion_con_el_token(self) -> None:
        with pytest.raises(ExternalKeyError) as caught:
            fetch(client(Server(httpx.ConnectError("x")), []))
        assert caught.value.__cause__ is None
        assert caught.value.__suppress_context__ is True


def test_no_sigue_redirecciones_para_no_mandar_el_token_a_otro_sitio() -> None:
    server = Server(httpx.Response(302, headers={"location": "http://atacante.example/robar"}))
    with pytest.raises(ExternalKeyError) as caught:
        fetch(client(server, []))
    assert caught.value.reason in ("unavailable", "bad_response")
    assert all(request.url.host == "api-gateway" for request in server.requests)


def test_ignora_las_variables_de_proxy_del_entorno(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}
    real = httpx.AsyncClient

    def spy(*args: object, **kwargs: object) -> httpx.AsyncClient:
        seen.update(kwargs)
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(httpx, "AsyncClient", spy)
    fetch(client(Server(ok())))
    assert seen["trust_env"] is False
    assert seen["follow_redirects"] is False


@pytest.mark.parametrize("url", ["", "ftp://api:3100", "http://usuario:clave@api:3100", "api:3100", "http://"])
def test_una_url_base_invalida_se_rechaza(url: str) -> None:
    with pytest.raises(ValueError):
        ExternalKeyClient(url, TOKEN)


def test_un_token_demasiado_corto_se_rechaza() -> None:
    with pytest.raises(ValueError):
        ExternalKeyClient(BASE, "corto")


class TestLease:
    def test_al_salir_se_borra_el_valor_pero_la_censura_se_conserva_un_tiempo(self) -> None:
        async def run() -> Secret:
            c = client(Server(ok()))
            async with c.lease(JOB, "openai") as secret:
                assert secret.reveal() == KEY
                assert REDACTED in REDACTOR.redact(f"x {KEY}")
            return secret

        secret = asyncio.run(run())
        with pytest.raises(ValueError):
            secret.reveal()
        # La traza del error que se propaga se registra DESPUÉS de salir del trabajo: sigue censurada.
        assert KEY not in REDACTOR.redact(f"traza tardía con {KEY}")

    def test_si_el_cuerpo_falla_tambien_se_borra(self) -> None:
        async def run() -> Secret:
            c = client(Server(ok()))
            holder: list[Secret] = []
            try:
                async with c.lease(JOB, "openai") as secret:
                    holder.append(secret)
                    raise RuntimeError("falló el proveedor")
            except RuntimeError:
                pass
            return holder[0]

        with pytest.raises(ValueError):
            asyncio.run(run()).reveal()


class TestConfig:
    BASE_ENV = {
        "REDIS_HOST": "redis",
        "REDIS_PASSWORD": "x",
        "DATABASE_URL": "postgresql://u:p@db/x",
        "S3_ENDPOINT": "http://s3:9000",
        "S3_BUCKET": "b",
        "S3_ACCESS_KEY": "a",
        "S3_SECRET_KEY": "s",
    }

    def test_sin_canal_interno_no_hay_url_ni_token(self) -> None:
        config = WorkerConfig.from_env(self.BASE_ENV)
        assert config.api_internal_url is None
        assert config.worker_internal_token is None

    def test_con_url_y_token_queda_configurado(self) -> None:
        config = WorkerConfig.from_env({**self.BASE_ENV, "API_INTERNAL_URL": BASE, "WORKER_INTERNAL_TOKEN": TOKEN})
        assert config.api_internal_url == BASE
        assert config.worker_internal_token == TOKEN

    def test_el_token_nunca_sale_en_el_repr_de_la_configuracion(self) -> None:
        config = WorkerConfig.from_env({**self.BASE_ENV, "API_INTERNAL_URL": BASE, "WORKER_INTERNAL_TOKEN": TOKEN})
        assert TOKEN not in repr(config)
        assert TOKEN not in str(config)

    @pytest.mark.parametrize("env", [{"API_INTERNAL_URL": BASE}, {"WORKER_INTERNAL_TOKEN": TOKEN}])
    def test_una_sola_de_las_dos_falla_al_arrancar(self, env: dict[str, str]) -> None:
        with pytest.raises(ConfigError):
            WorkerConfig.from_env({**self.BASE_ENV, **env})

    def test_un_token_corto_o_una_url_invalida_fallan_sin_repetir_el_valor(self) -> None:
        with pytest.raises(ConfigError) as short:
            WorkerConfig.from_env({**self.BASE_ENV, "API_INTERNAL_URL": BASE, "WORKER_INTERNAL_TOKEN": "corto-pero-secreto"})
        assert "corto-pero-secreto" not in str(short.value)
        with pytest.raises(ConfigError):
            WorkerConfig.from_env({**self.BASE_ENV, "API_INTERNAL_URL": "ftp://x", "WORKER_INTERNAL_TOKEN": TOKEN})
