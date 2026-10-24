"""URL base propia y modelo del espacio (ADR 0022): el worker resuelve el DNS justo antes de cada petición y NO envía la clave a una
dirección no permitida. Sin red real: el DNS y el transporte de httpx son falsos."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Sequence
from contextlib import asynccontextmanager

import httpx
import pytest

from ai_worker.adapters import Adapters
from ai_worker.config import ConfigError, WorkerConfig
from ai_worker.errors import JobFailure
from ai_worker.external_key import ExternalCredential, ExternalKeyClient, ExternalKeyError
from ai_worker.net_guard import AddressClass, assert_url_allowed, classify_address
from ai_worker.redaction import REDACTOR, Secret

KEY = "clave-de-prueba-3b7e91c4d2a60f58"
TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c"
JOB = str(uuid.uuid4())


@pytest.fixture(autouse=True)
def _limpio():
    REDACTOR.clear()
    yield
    REDACTOR.clear()


# ---------------------------------------------------------------- clasificación de direcciones
@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("8.8.8.8", "public"),
        ("142.250.80.46", "public"),
        ("2606:4700:4700::1111", "public"),
        ("127.0.0.1", "private"),
        ("10.1.2.3", "private"),
        ("172.16.0.9", "private"),
        ("192.168.1.50", "private"),
        ("100.64.0.1", "private"),
        ("::1", "private"),
        ("fd12:3456::1", "private"),
        ("169.254.169.254", "forbidden"),
        ("169.254.0.1", "forbidden"),
        ("0.0.0.0", "forbidden"),
        ("224.0.0.1", "forbidden"),
        ("255.255.255.255", "forbidden"),
        ("::", "forbidden"),
        ("fe80::1", "forbidden"),
        ("ff02::1", "forbidden"),
        ("::ffff:127.0.0.1", "forbidden"),
        ("::ffff:8.8.8.8", "forbidden"),
        ("192.0.2.1", "forbidden"),
        ("2001:db8::1", "forbidden"),
        ("no-es-una-ip", "forbidden"),
    ],
)
def test_clasifica_las_direcciones(address: str, expected: AddressClass) -> None:
    assert classify_address(address) == expected


# ---------------------------------------------------------------- guardia de DNS
def resolver_for(*answers: Sequence[str]):
    """Un DNS falso que responde, en orden, cada lista de direcciones (la última se repite) y cuenta las consultas."""
    calls: list[str] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append(host)
        return list(answers[min(len(calls) - 1, len(answers) - 1)])

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


def run(coro):
    return asyncio.run(coro)


def test_un_nombre_publico_pasa() -> None:
    resolve = resolver_for(["93.184.216.34"])
    run(assert_url_allowed("https://llm.example.com/v1", allow_private=False, resolve=resolve))
    assert resolve.calls == ["llm.example.com"]


def test_un_nombre_que_resuelve_a_una_red_privada_se_aborta_aunque_el_nombre_parezca_publico() -> None:
    for private in ("10.0.0.5", "192.168.1.9", "127.0.0.1", "100.64.0.3", "::1", "fd00::5"):
        with pytest.raises(JobFailure) as failure:
            run(assert_url_allowed("https://llm.example.com/v1", allow_private=False, resolve=resolver_for([private])))
        assert failure.value.code == "EXTERNAL_UNAVAILABLE", private
        assert "llm.example.com" not in failure.value.message  # el mensaje no repite la URL


def test_basta_una_respuesta_privada_entre_varias_para_abortar() -> None:
    with pytest.raises(JobFailure):
        run(assert_url_allowed("https://llm.example.com", allow_private=False, resolve=resolver_for(["93.184.216.34", "10.0.0.5"])))


def test_con_la_bandera_se_permiten_las_redes_privadas_pero_no_los_metadatos() -> None:
    run(assert_url_allowed("http://ollama:11434/v1", allow_private=True, resolve=resolver_for(["172.18.0.5"])))
    run(assert_url_allowed("http://host.docker.internal:11434", allow_private=True, resolve=resolver_for(["192.168.65.254"])))
    for forbidden in ("169.254.169.254", "0.0.0.0", "fe80::1", "224.0.0.1", "::ffff:127.0.0.1"):
        with pytest.raises(JobFailure):
            run(assert_url_allowed("http://ollama:11434/v1", allow_private=True, resolve=resolver_for([forbidden])))


def test_una_ip_literal_no_consulta_el_dns() -> None:
    resolve = resolver_for(["8.8.8.8"])
    run(assert_url_allowed("http://127.0.0.1:8000/v1", allow_private=True, resolve=resolve))
    assert resolve.calls == []
    with pytest.raises(JobFailure):
        run(assert_url_allowed("http://127.0.0.1:8000/v1", allow_private=False, resolve=resolve))
    with pytest.raises(JobFailure):
        run(assert_url_allowed("http://169.254.169.254/latest", allow_private=True, resolve=resolve))


def test_http_sin_cifrar_solo_con_destino_privado() -> None:
    with pytest.raises(JobFailure):
        run(assert_url_allowed("http://llm.example.com/v1", allow_private=True, resolve=resolver_for(["93.184.216.34"])))


def test_si_el_dns_falla_o_no_responde_nada_se_aborta() -> None:
    async def broken(host: str, port: int) -> list[str]:
        raise OSError("sin DNS")

    with pytest.raises(JobFailure):
        run(assert_url_allowed("https://llm.example.com", allow_private=False, resolve=broken))
    with pytest.raises(JobFailure):
        run(assert_url_allowed("https://llm.example.com", allow_private=False, resolve=resolver_for([])))


@pytest.mark.parametrize("url", ["ftp://llm.example.com", "https://user:pass@llm.example.com", "https://llm.example.com/v1?x=1", "https://llm.example.com/v1#x", "no es una url", ""])
def test_rechaza_urls_mal_formadas(url: str) -> None:
    with pytest.raises(JobFailure):
        run(assert_url_allowed(url, allow_private=True, resolve=resolver_for(["93.184.216.34"])))


# ---------------------------------------------------------------- adaptador de traducción con baseUrl y model
class FakeKeys:
    def __init__(self, base_url: str | None = None, model: str | None = None) -> None:
        self.base_url, self.model = base_url, model

    @asynccontextmanager
    async def lease_credential(self, job_id: str, provider: str):
        yield ExternalCredential(Secret(KEY), self.base_url, self.model)

    @asynccontextmanager
    async def lease(self, job_id: str, provider: str):
        yield Secret(KEY)


def chat_reply(request: httpx.Request) -> httpx.Response:
    asked = json.loads(json.loads(request.content)["messages"][-1]["content"])
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"translations": [f"[{asked['target']}] {t}" for t in asked["texts"]]})}}]})


def make(keys: FakeKeys, resolve, *, allow_private: bool = False, reply=chat_reply):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return reply(request)

    async def no_sleep(_: float) -> None:
        return None

    adapters = Adapters(keys, transport=httpx.MockTransport(handler), allow_private_base_urls=allow_private, resolve=resolve, sleep=no_sleep)  # type: ignore[arg-type]
    return adapters, seen


def translate(adapters: Adapters, texts: list[str]) -> list[str]:
    async def go() -> list[str]:
        async with adapters.translator("openai", JOB) as translator:
            return await translator.translate(texts, "es", "en")

    return run(go())


def test_sin_baseurl_ni_modelo_nada_cambia_host_de_openai_modelo_por_defecto_y_sin_dns() -> None:
    resolve = resolver_for(["10.0.0.5"])
    adapters, seen = make(FakeKeys(), resolve)
    assert translate(adapters, ["hola"]) == ["[en] hola"]
    assert seen[0].url.host == "api.openai.com" and seen[0].url.path == "/v1/chat/completions"
    assert json.loads(seen[0].content)["model"] == "gpt-4o-mini"
    assert resolve.calls == []  # el host fijo de OpenAI no se resuelve ni se vigila


def test_con_baseurl_y_modelo_usa_ese_servidor_esa_ruta_y_ese_modelo() -> None:
    adapters, seen = make(FakeKeys("https://api.deepseek.com/v1", "deepseek-chat"), resolver_for(["93.184.216.34"]))
    assert translate(adapters, ["hola", "mundo"]) == ["[en] hola", "[en] mundo"]
    request = seen[0]
    assert (request.url.scheme, request.url.host, request.url.path) == ("https", "api.deepseek.com", "/v1/chat/completions")
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(request.content)["model"] == "deepseek-chat"


def test_baseurl_sin_ruta_y_con_puerto() -> None:
    adapters, seen = make(FakeKeys("https://llm.example.com:8443"), resolver_for(["93.184.216.34"]))
    translate(adapters, ["hola"])
    assert (seen[0].url.host, seen[0].url.port, seen[0].url.path) == ("llm.example.com", 8443, "/chat/completions")


def test_solo_el_modelo_se_usa_con_el_host_de_openai() -> None:
    adapters, seen = make(FakeKeys(None, "gpt-4.1-mini"), resolver_for(["10.0.0.5"]))
    translate(adapters, ["hola"])
    assert seen[0].url.host == "api.openai.com"
    assert json.loads(seen[0].content)["model"] == "gpt-4.1-mini"


def test_si_el_host_resuelve_a_una_ip_privada_se_aborta_sin_enviar_la_clave() -> None:
    adapters, seen = make(FakeKeys("https://llm.example.com/v1"), resolver_for(["10.0.0.5"]))
    with pytest.raises(JobFailure) as failure:
        translate(adapters, ["hola"])
    assert failure.value.code == "EXTERNAL_UNAVAILABLE"
    assert seen == []  # ninguna petición salió: la clave no viajó a ninguna parte
    assert KEY not in failure.value.message


def test_con_la_bandera_un_servidor_local_funciona_por_http() -> None:
    adapters, seen = make(FakeKeys("http://ollama:11434/v1", "llama3.1:8b"), resolver_for(["172.18.0.5"]), allow_private=True)
    assert translate(adapters, ["hola"]) == ["[en] hola"]
    assert (seen[0].url.scheme, seen[0].url.host, seen[0].url.port) == ("http", "ollama", 11434)
    assert json.loads(seen[0].content)["model"] == "llama3.1:8b"


def test_con_la_bandera_los_metadatos_de_nube_siguen_bloqueados() -> None:
    adapters, seen = make(FakeKeys("http://metadatos.example/v1"), resolver_for(["169.254.169.254"]), allow_private=True)
    with pytest.raises(JobFailure):
        translate(adapters, ["hola"])
    assert seen == []


def test_el_dns_se_vuelve_a_comprobar_en_cada_reintento_contra_el_rebinding() -> None:
    """Primera respuesta: pública; el proveedor falla con 503 y en el reintento el nombre ya resuelve a una IP privada."""
    state = {"n": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        state["n"] += 1
        return httpx.Response(503, json={"error": {"code": "overloaded"}}) if state["n"] == 1 else chat_reply(request)

    adapters, seen = make(FakeKeys("https://llm.example.com/v1"), resolver_for(["93.184.216.34"], ["10.0.0.5"]), reply=flaky)
    with pytest.raises(JobFailure):
        translate(adapters, ["hola"])
    assert len(seen) == 1  # solo salió la primera petición; la segunda se abortó antes de enviarse


def test_la_clave_no_aparece_en_el_mensaje_ni_en_la_representacion_de_la_credencial() -> None:
    credential = ExternalCredential(Secret(KEY), "https://llm.example.com/v1", "deepseek-chat")
    assert KEY not in repr(credential)
    assert KEY not in str(credential)


# ---------------------------------------------------------------- cliente del canal interno
class Server:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    def __call__(self, request: httpx.Request) -> httpx.Response:
        return self.response


def fetch_credential(response: httpx.Response) -> ExternalCredential:
    client = ExternalKeyClient("http://api-gateway:3100", TOKEN, transport=httpx.MockTransport(Server(response)))

    async def go() -> ExternalCredential:
        async with client.lease_credential(JOB, "openai") as credential:
            return credential

    return run(go())


def test_el_cliente_lee_key_baseurl_y_model() -> None:
    credential = fetch_credential(httpx.Response(200, json={"key": KEY, "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat"}))
    assert (credential.base_url, credential.model) == ("https://api.deepseek.com/v1", "deepseek-chat")


def test_el_cliente_acepta_la_respuesta_antigua_solo_con_key() -> None:
    credential = fetch_credential(httpx.Response(200, json={"key": KEY}))
    assert (credential.base_url, credential.model) == (None, None)


@pytest.mark.parametrize("extra", [{"baseUrl": 5}, {"baseUrl": ""}, {"model": 5}, {"model": ""}, {"baseUrl": "x" * 3000}, {"model": "x" * 300}, {"baseUrl": None, "model": ["a"]}])
def test_el_cliente_rechaza_una_respuesta_con_campos_raros(extra: dict) -> None:
    with pytest.raises(ExternalKeyError) as error:
        fetch_credential(httpx.Response(200, json={"key": KEY, **extra}))
    assert error.value.reason == "bad_response"
    assert KEY not in str(error.value)


def test_lease_sigue_entregando_solo_el_secreto_para_la_voz() -> None:
    client = ExternalKeyClient("http://api-gateway:3100", TOKEN, transport=httpx.MockTransport(Server(httpx.Response(200, json={"key": KEY, "baseUrl": "https://api.deepseek.com/v1"}))))

    async def go() -> str:
        async with client.lease(JOB, "openai") as secret:
            return secret.reveal()

    assert run(go()) == KEY


# ---------------------------------------------------------------- configuración
BASE_ENV = {
    "REDIS_HOST": "r", "REDIS_PASSWORD": "p", "DATABASE_URL": "postgresql://u:p@h/db",
    "S3_ENDPOINT": "http://s3:9000", "S3_BUCKET": "b", "S3_ACCESS_KEY": "a", "S3_SECRET_KEY": "s",
}


def test_la_bandera_del_worker_esta_apagada_por_defecto() -> None:
    assert WorkerConfig.from_env(BASE_ENV).allow_private_base_urls is False
    assert WorkerConfig.from_env({**BASE_ENV, "ALLOW_PRIVATE_BASE_URLS": ""}).allow_private_base_urls is False
    assert WorkerConfig.from_env({**BASE_ENV, "ALLOW_PRIVATE_BASE_URLS": "false"}).allow_private_base_urls is False


@pytest.mark.parametrize("value", ["true", "TRUE", " 1 "])
def test_la_bandera_del_worker_se_enciende_solo_con_un_valor_explicito(value: str) -> None:
    assert WorkerConfig.from_env({**BASE_ENV, "ALLOW_PRIVATE_BASE_URLS": value}).allow_private_base_urls is True


@pytest.mark.parametrize("value", ["yes", "on", "ture", "2"])
def test_un_valor_ambiguo_hace_fallar_el_arranque(value: str) -> None:
    with pytest.raises(ConfigError, match="ALLOW_PRIVATE_BASE_URLS"):
        WorkerConfig.from_env({**BASE_ENV, "ALLOW_PRIVATE_BASE_URLS": value})
