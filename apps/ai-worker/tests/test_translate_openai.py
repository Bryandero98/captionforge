"""Traducción con OpenAI y clave propia (ADR 0020, T7b): la clave llega del canal interno, se usa contra un OpenAI falso (HTTP real)
y no queda en ningún sitio. Incluye la resiliencia del worker (T8): un proveedor caído falla UN trabajo y el siguiente se procesa."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from bullmq import Queue

from ai_worker.adapters import Adapters
from ai_worker.db import JobRepository
from ai_worker.errors import JobFailure
from ai_worker.external_key import ExternalKeyClient
from ai_worker.progress import TRANSLATE_STAGE_RANGES, Progress
from ai_worker.redaction import REDACTOR
from ai_worker.translate import TranslateRunner
from ai_worker.worker import AiWorker
from captionforge_contracts import TranslateJob

from conftest import sample_segments
from test_pipeline import read_object
from test_translate_job import FakeTranslator
from test_worker_queue import TERMINAL, isolated, wait_for

KEY = "sk-canario-7d3f0a91c4e2685b1a9d03f7e5c28b64"
TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c"


class FakeOpenAI:
    """Un OpenAI de mentira (HTTP real): traduce `[xx] texto` y puede fallar de las maneras que fallan los proveedores."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.mode = "ok"  # ok | 429 | 500 | wrong_count | not_json | broken
        handler = self._handler()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _handler(self):  # noqa: ANN202
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                outer.requests.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": body})
                if outer.mode in ("429", "500"):
                    return self._send(int(outer.mode), {"error": {"message": f"Incorrect API key provided: {KEY}", "code": "rate_limit_exceeded"}})
                if outer.mode == "broken":
                    return self._send(200, b"<html>no soy json</html>")
                asked = json.loads(body["messages"][-1]["content"])
                out = [f"[{asked['target']}] {t}" for t in asked["texts"]]
                if outer.mode == "wrong_count":
                    out = out[:-1]
                content = json.dumps({"translations": out}) if outer.mode != "not_json" else "esto no es json"
                self._send(200, {"choices": [{"message": {"content": content}}]})

            def _send(self, status: int, body: object) -> None:
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("retry-after", "0")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: object) -> None:
                pass

        return Handler

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class InternalChannel:
    """El canal interno del API, falso: entrega la clave del trabajo (o dice que falta) y recuerda qué se pidió."""

    def __init__(self, reply: httpx.Response | None = None) -> None:
        self.reply = reply or httpx.Response(200, json={"key": KEY})
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.reply


async def no_sleep(_seconds: float) -> None:
    return None


@pytest.fixture
def openai():
    fake = FakeOpenAI()
    yield fake
    fake.close()


@pytest.fixture(autouse=True)
def _redactor():
    REDACTOR.clear()
    yield
    REDACTOR.clear()


def build_adapters(openai: FakeOpenAI, channel: InternalChannel, **kwargs) -> Adapters:  # noqa: ANN003
    keys = ExternalKeyClient("http://api-gateway:3100", TOKEN, transport=httpx.MockTransport(channel), sleep=no_sleep)
    return Adapters(keys, base_urls={"openai": openai.url}, sleep=no_sleep, **kwargs)


def run_translate(config, storage, payload, adapters):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    runner = TranslateRunner(config, storage, adapters)
    model = TranslateJob.model_validate_json(json.dumps(payload), strict=True)

    async def go():
        assert await repo.claim(payload["jobId"])
        progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0, ranges=TRANSLATE_STAGE_RANGES)
        return await runner.run(model, progress, threading.Event())

    try:
        return asyncio.run(go())
    finally:
        repo.close()


def test_translates_with_the_workspace_key_fetched_once_for_the_whole_job(config, storage, new_translate_job, openai) -> None:  # noqa: ANN001
    many = [{"start": i, "end": i + 0.9, "text": f"Frase {i}", "words": None} for i in range(95)]
    job_id, payload, _ = new_translate_job(provider="openai", segments=many, source="en", target="es")
    channel = InternalChannel()
    result = run_translate(config, storage, payload, build_adapters(openai, channel))

    assert result["provider"] == "openai" and result["segmentCount"] == 95
    translated = json.loads(read_object(storage, result["artifacts"]["segments"]["objectKey"]))
    assert [s["text"] for s in translated] == [f"[es] Frase {i}" for i in range(95)]
    # La clave se pidió UNA vez, al API, para ESTE trabajo y este proveedor; y el proveedor la recibió tal cual.
    [asked] = channel.requests
    assert asked.url.path == f"/internal/v1/jobs/{job_id}/external-key" and json.loads(asked.content) == {"provider": "openai"}
    assert len(openai.requests) == 3  # 95 segmentos en lotes de 40
    assert {request["authorization"] for request in openai.requests} == {f"Bearer {KEY}"}
    assert all(request["path"] == "/v1/chat/completions" for request in openai.requests)


def test_the_key_never_reaches_logs_results_files_or_the_database(config, storage, new_translate_job, openai, api_db, caplog) -> None:  # noqa: ANN001
    caplog.set_level(logging.DEBUG)
    job_id, payload, _ = new_translate_job(provider="openai")
    result = run_translate(config, storage, payload, build_adapters(openai, InternalChannel()))
    stored = read_object(storage, result["artifacts"]["segments"]["objectKey"]).decode()
    row = api_db.execute('SELECT options, result, "errorMessage", message FROM "Job" WHERE id = %s', (job_id,)).fetchone()
    for where, text in {"registros": caplog.text, "resultado": json.dumps(result), "artefacto": stored, "fila": json.dumps(row, default=str)}.items():
        assert KEY not in text and KEY[3:25] not in text, where


@pytest.mark.parametrize(
    ("mode", "code"),
    [("429", "EXTERNAL_RATE_LIMITED"), ("500", "EXTERNAL_UNAVAILABLE"), ("wrong_count", "EXTERNAL_UNAVAILABLE"), ("not_json", "EXTERNAL_UNAVAILABLE"), ("broken", "EXTERNAL_UNAVAILABLE")],
)
def test_provider_failures_become_external_codes_without_provider_text(mode, code, config, storage, new_translate_job, openai) -> None:  # noqa: ANN001
    _, payload, _ = new_translate_job(provider="openai")
    openai.mode = mode
    with pytest.raises(JobFailure) as caught:
        run_translate(config, storage, payload, build_adapters(openai, InternalChannel()))
    assert caught.value.code == code
    assert KEY not in caught.value.message and "Incorrect API key" not in caught.value.message


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (httpx.Response(404, json={"code": "external_key_not_found"}), "EXTERNAL_KEY_MISSING"),
        (httpx.Response(503, json={"code": "byok_disabled"}), "EXTERNAL_KEY_MISSING"),
        (httpx.Response(403, json={"code": "job_not_running"}), "INTERNAL"),
        (httpx.Response(401, json={"code": "unauthorized"}), "INTERNAL"),
    ],
)
def test_a_missing_or_refused_key_fails_before_calling_openai(reply, code, config, storage, new_translate_job, openai) -> None:  # noqa: ANN001
    _, payload, _ = new_translate_job(provider="openai")
    with pytest.raises(JobFailure) as caught:
        run_translate(config, storage, payload, build_adapters(openai, InternalChannel(reply)))
    assert caught.value.code == code
    assert openai.requests == [], "sin clave no se llama al proveedor"


def test_without_an_internal_channel_an_external_provider_cannot_run(config, storage, new_translate_job, openai) -> None:  # noqa: ANN001
    _, payload, _ = new_translate_job(provider="openai")
    with pytest.raises(JobFailure) as caught:
        run_translate(config, storage, payload, Adapters(None, base_urls={"openai": openai.url}, sleep=no_sleep))
    assert caught.value.code == "EXTERNAL_KEY_MISSING"
    assert openai.requests == []


# ---------------------------------------------------------------- resiliencia del worker (T8)
async def enqueue(config, payload: dict) -> Queue:  # noqa: ANN001
    queue = Queue(config.translate_queue_name, {"connection": config.redis_connection})
    await queue.add("translate", payload, {"jobId": payload["jobId"], "attempts": 1})
    return queue


class Boom(FakeTranslator):
    async def translate(self, texts, source, target):  # noqa: ANN001
        raise RuntimeError(f"explotó con {KEY}")


@pytest.mark.parametrize("failure", ["rate_limited", "unexpected_exception"])
def test_a_failing_provider_fails_that_job_and_the_worker_goes_on_with_the_next(failure, config, new_translate_job, api_db, fake_models, openai, storage) -> None:  # noqa: ANN001
    cfg = isolated(config)
    bad_id, bad_payload, _ = new_translate_job(provider="openai")
    good_id, good_payload, _ = new_translate_job(provider="argos")
    if failure == "rate_limited":
        openai.mode = "429"
        adapters = build_adapters(openai, InternalChannel(), translators={"argos": FakeTranslator()})
    else:
        adapters = Adapters(None, translators={"openai": Boom(), "argos": FakeTranslator()}, sleep=no_sleep)

    async def go() -> tuple[dict, dict]:
        worker = AiWorker(cfg, models=fake_models, adapters=adapters)
        await worker.start()
        queues = [await enqueue(cfg, bad_payload), await enqueue(cfg, good_payload)]
        try:
            bad = await wait_for(api_db, bad_id, until=lambda r: r["status"] in TERMINAL, timeout=90)
            good = await wait_for(api_db, good_id, until=lambda r: r["status"] in TERMINAL, timeout=90)
            return bad, good
        finally:
            for queue in queues:
                await queue.close()
            await worker.stop()

    bad, good = asyncio.run(go())
    expected = "EXTERNAL_RATE_LIMITED" if failure == "rate_limited" else "INTERNAL"
    assert (bad["status"], bad["errorCode"]) == ("FAILED", expected)
    assert KEY not in json.dumps(bad, default=str), "ni el error del proveedor ni la traza llevan la clave"
    assert good["status"] == "COMPLETED", "el worker sigue vivo y procesa el siguiente trabajo"
    assert sample_segments()  # el fixture de segmentos es el mismo en ambos
    assert uuid.UUID(bad_id) != uuid.UUID(good_id)
