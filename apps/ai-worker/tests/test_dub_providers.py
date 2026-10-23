"""Doblaje con OpenAI y ElevenLabs (ADR 0020, T9a): la clave llega del canal interno, se usa contra un TTS falso (HTTP real, MP3 reales)
y no queda en ningún sitio. Incluye la resiliencia del worker: un proveedor sin saldo falla UN doblaje y el siguiente se procesa."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from bullmq import Queue
from captionforge_contracts import DubJob, DubResult

from ai_worker.adapters import Adapters
from ai_worker.db import JobRepository
from ai_worker.dub import DubRunner
from ai_worker.errors import JobFailure
from ai_worker.external_key import ExternalKeyClient
from ai_worker.progress import DUB_STAGE_RANGES, Progress
from ai_worker.redaction import REDACTOR
from ai_worker.worker import AiWorker

from test_dub_job import seg, tone_mp3
from test_pipeline import read_object
from test_translate_openai import InternalChannel, no_sleep
from test_worker_queue import TERMINAL, isolated, wait_for

OPENAI_KEY = "sk-canario-5e8b2d90f1a74c36b8d0e2f4a6c19375"
ELEVEN_KEY = "eleven-canario-91c4e7a03b6d58f2a1e9c0b7d4f38a65"
TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c"


class FakeTts:
    """TTS de mentira por HTTP real: contesta MP3 reales de 0,5 s y puede fallar como fallan los proveedores."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.mode = "ok"  # ok | quota | 401 | json_200 | empty_200
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                mode = outer.mode
                if mode == "quota":
                    return self._send(402, "application/json", json.dumps({"error": {"message": f"billing: {OPENAI_KEY}"}}).encode())
                if mode == "401":
                    return self._send(401, "application/json", json.dumps({"detail": {"status": "quota_exceeded"}}).encode())
                if mode == "json_200":
                    return self._send(200, "application/json", b'{"ok": true}' + b" " * 300)
                if mode == "empty_200":
                    return self._send(200, "audio/mpeg", b"")
                self._send(200, "audio/mpeg", tone_mp3(0.5))

            def _send(self, status: int, content_type: str, raw: bytes) -> None:
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def tts():
    fake = FakeTts()
    yield fake
    fake.close()


@pytest.fixture(autouse=True)
def _redactor():
    REDACTOR.clear()
    yield
    REDACTOR.clear()


def adapters_for(tts: FakeTts, provider: str, key: str) -> tuple[Adapters, InternalChannel]:
    channel = InternalChannel(httpx.Response(200, json={"key": key}))
    keys = ExternalKeyClient("http://api-gateway:3100", TOKEN, transport=httpx.MockTransport(channel), sleep=no_sleep)
    return Adapters(keys, base_urls={provider: tts.url}, sleep=no_sleep), channel


def run_dub(config, storage, payload, adapters):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    runner = DubRunner(config, storage, adapters)
    model = DubJob.model_validate_json(json.dumps(payload), strict=True)

    async def go():
        assert await repo.claim(payload["jobId"])
        progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0, ranges=DUB_STAGE_RANGES)
        return await runner.run(model, progress, threading.Event())

    try:
        return asyncio.run(go())
    finally:
        repo.close()


THREE = [seg(0.0, 0.7, "Uno"), seg(1.0, 1.7, "Dos"), seg(2.0, 2.7, "Tres")]


def test_openai_voice_sends_the_documented_request_with_the_workspace_key(config, storage, new_dub_job, tts) -> None:  # noqa: ANN001
    job_id, payload, _ = new_dub_job(provider="openai", voice="nova", segments=THREE)
    adapters, channel = adapters_for(tts, "openai", OPENAI_KEY)
    result = run_dub(config, storage, payload, adapters)

    DubResult.model_validate_json(json.dumps(result), strict=True)
    [asked] = channel.requests
    assert asked.url.path == f"/internal/v1/jobs/{job_id}/external-key" and json.loads(asked.content) == {"provider": "openai"}
    assert len(tts.requests) == 3
    first = tts.requests[0]
    assert first["path"] == "/v1/audio/speech" and first["headers"]["authorization"] == f"Bearer {OPENAI_KEY}"
    assert first["body"] == {"model": "tts-1", "voice": "nova", "input": "Uno", "response_format": "mp3"}


def test_elevenlabs_voice_uses_its_own_header_and_path(config, storage, new_dub_job, tts) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(provider="elevenlabs", voice="21m00Tcm4TlvDq8ikWAM", segments=THREE)
    adapters, channel = adapters_for(tts, "elevenlabs", ELEVEN_KEY)
    run_dub(config, storage, payload, adapters)

    assert json.loads(channel.requests[0].content) == {"provider": "elevenlabs"}
    first = tts.requests[0]
    assert first["path"] == "/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128"
    assert first["headers"]["xi-api-key"] == ELEVEN_KEY and "authorization" not in {name.lower() for name in first["headers"]}
    assert first["body"] == {"text": "Uno", "model_id": "eleven_multilingual_v2"}


@pytest.mark.parametrize(("mode", "code"), [("quota", "EXTERNAL_QUOTA_EXCEEDED"), ("401", "EXTERNAL_QUOTA_EXCEEDED"), ("json_200", "EXTERNAL_UNAVAILABLE"), ("empty_200", "EXTERNAL_UNAVAILABLE")])
def test_a_provider_without_balance_or_returning_no_audio_is_a_controlled_failure(mode, code, config, storage, new_dub_job, tts) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(provider="openai", segments=THREE)
    tts.mode = mode
    adapters, _ = adapters_for(tts, "openai", OPENAI_KEY)
    with pytest.raises(JobFailure) as caught:
        run_dub(config, storage, payload, adapters)
    assert caught.value.code == code
    assert OPENAI_KEY not in caught.value.message and "billing" not in caught.value.message
    assert len(tts.requests) == 1, "el primer fallo detiene el doblaje: no se sigue gastando"


def test_the_key_never_reaches_logs_results_files_or_the_database(config, storage, new_dub_job, tts, api_db, caplog) -> None:  # noqa: ANN001
    caplog.set_level(logging.DEBUG)
    job_id, payload, _ = new_dub_job(provider="openai", segments=THREE)
    adapters, _ = adapters_for(tts, "openai", OPENAI_KEY)
    result = run_dub(config, storage, payload, adapters)
    audio = read_object(storage, result["artifacts"]["audio"])
    row = api_db.execute('SELECT options, result, "errorMessage", message FROM "Job" WHERE id = %s', (job_id,)).fetchone()
    for where, text in {"registros": caplog.text, "resultado": json.dumps(result), "fila": json.dumps(row, default=str), "audio": audio.decode("latin1")}.items():
        assert OPENAI_KEY not in text and OPENAI_KEY[3:25] not in text, where


async def enqueue(config, payload: dict) -> Queue:  # noqa: ANN001
    queue = Queue(config.dub_queue_name, {"connection": config.redis_connection})
    await queue.add("dub", payload, {"jobId": payload["jobId"], "attempts": 1})
    return queue


def test_dub_jobs_go_through_their_queue_and_a_failed_one_does_not_stop_the_next(config, new_dub_job, api_db, fake_models, tts) -> None:  # noqa: ANN001
    cfg = isolated(config)
    bad_id, bad_payload, _ = new_dub_job(provider="elevenlabs", segments=THREE)
    good_id, good_payload, _ = new_dub_job(provider="openai", segments=THREE)
    broken = FakeTts()
    broken.mode = "quota"
    keys = ExternalKeyClient("http://api-gateway:3100", TOKEN, transport=httpx.MockTransport(_per_provider_channel()), sleep=no_sleep)
    adapters = Adapters(keys, base_urls={"openai": tts.url, "elevenlabs": broken.url}, sleep=no_sleep)

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
            broken.close()

    bad, good = asyncio.run(go())
    assert (bad["status"], bad["errorCode"]) == ("FAILED", "EXTERNAL_QUOTA_EXCEEDED")
    assert good["status"] == "COMPLETED" and good["result"]["artifacts"]["audio"].endswith("/dub.mp3")
    DubResult.model_validate_json(json.dumps(good["result"]), strict=True)
    assert OPENAI_KEY not in json.dumps([bad, good], default=str)


def _per_provider_channel():  # noqa: ANN202
    def handler(request: httpx.Request) -> httpx.Response:
        provider = json.loads(request.content)["provider"]
        return httpx.Response(200, json={"key": OPENAI_KEY if provider == "openai" else ELEVEN_KEY})

    return handler
