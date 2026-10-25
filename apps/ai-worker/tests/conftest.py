"""Fixtures comunes. Las pruebas de integración usan PostgreSQL, Redis y S3 REALES (`npm run infra:up`
y la migración aplicada) y ffmpeg real; solo Whisper se simula, porque cargar un modelo en cada
ejecución no aporta nada al contrato que se prueba aquí."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

from ai_worker.config import WorkerConfig
from ai_worker.models import ModelProvider
from ai_worker.storage import Storage

REPO = Path(__file__).resolve().parents[3]
CLIP = REPO / "legacy" / "tests" / "fixtures" / "tiny_test_clip.mp4"
# Tenant "Default" que crea la migración de tenencia (ADR 0015): todo trabajo pertenece a un tenant.
DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001"


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.fail(f"Falta {name}: ejecuta las pruebas con `node scripts/test.mjs` (carga el .env).", pytrace=False)
    return value


@pytest.fixture(scope="session")
def config(tmp_path_factory: pytest.TempPathFactory) -> WorkerConfig:
    base = WorkerConfig.from_env({**os.environ, "WORK_DIR": str(tmp_path_factory.mktemp("work")), "FONTS_DIR": str(REPO / "apps" / "ai-worker" / "fonts")})
    return base


@pytest.fixture(scope="session")
def storage(config: WorkerConfig) -> Storage:
    return Storage(config)


@pytest.fixture(scope="session")
def api_db():
    """Conexión con el rol cf_api: es quien inserta los trabajos (el worker no puede)."""
    with psycopg.connect(env("DATABASE_URL_API"), autocommit=True) as connection:
        yield connection


@pytest.fixture
def new_job(api_db, storage: Storage, config: WorkerConfig):
    """Crea un trabajo como lo haría el API: video en S3 + fila QUEUED. Devuelve (id, payload)."""
    created: list[str] = []

    def make(*, filename: str = "entrevista.mp4", options: dict | None = None, upload_input: bool = True) -> tuple[str, dict]:
        job_id = str(uuid.uuid4())
        input_key = f"jobs/{job_id}/input.mp4"
        output_prefix = f"jobs/{job_id}/out/"
        if upload_input:
            storage.upload_file(CLIP, input_key, "video/mp4")
        merged = {"modelSize": "base", "sourceLanguage": None, "translateTo": None, **(options or {})}
        api_db.execute(
            """INSERT INTO "Job" (id, "tenantId", kind, "inputBucket", "inputKey", "originalFilename", "contentType",
                 "sizeBytes", "outputPrefix", options, "updatedAt")
               VALUES (%s, %s, 'TRANSCRIBE', %s, %s, %s, 'video/mp4', %s, %s, %s::jsonb, now())""",
            (job_id, DEFAULT_TENANT_ID, config.s3_bucket, input_key, filename, CLIP.stat().st_size, output_prefix, __import__("json").dumps(merged)),
        )
        created.append(job_id)
        payload = {
            "schemaVersion": 1,
            "jobId": job_id,
            "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "input": {
                "bucket": config.s3_bucket,
                "objectKey": input_key,
                "originalFilename": filename,
                "contentType": "video/mp4",
                "sizeBytes": CLIP.stat().st_size,
            },
            "outputPrefix": output_prefix,
            "options": merged,
        }
        return job_id, payload

    yield make
    for job_id in created:
        api_db.execute('DELETE FROM "Job" WHERE id = %s', (job_id,))


def sample_segments(words: bool = True) -> list[dict]:
    """segments.json como lo deja la transcripción: lista de segmentos, con tiempos por palabra o sin ellos."""
    segments = []
    for i in range(3):
        start = i * 0.8
        segment = {"start": start, "end": start + 0.7, "text": f" Hola {i}", "words": None}
        if words:
            segment["words"] = [
                {"start": start, "end": start + 0.3, "text": " Hola", "probability": 0.9},
                {"start": start + 0.3, "end": start + 0.7, "text": f" {i}", "probability": 0.9},
            ]
        segments.append(segment)
    return segments


@pytest.fixture
def new_burn_job(api_db, storage: Storage, config: WorkerConfig, new_job, tmp_path):
    """Crea un trabajo de quemado como lo haría el API: transcripción padre con su video y su
    segments.json en S3, y la fila BURN en estado QUEUED. Devuelve (id, payload, etag)."""
    created: list[str] = []

    def make(
        *,
        segments: list[dict] | None = None,
        raw_segments: bytes | None = None,
        karaoke: bool = False,
        style: str = "modern",
        template: str | None = None,
        canvas: str | None = None,
        upload_video: bool = True,
        upload_segments: bool = True,
    ) -> tuple[str, dict, str]:
        parent_id, parent_payload = new_job(upload_input=upload_video)
        burn_id = str(uuid.uuid4())
        segments_key = f"{parent_payload['outputPrefix']}segments.json"
        etag = "0" * 32
        if upload_segments:
            body = raw_segments if raw_segments is not None else json.dumps(sample_segments() if segments is None else segments).encode()
            path = tmp_path / f"{burn_id}.json"
            path.write_bytes(body)
            etag = storage.upload_file(path, segments_key, "application/json")
        output_prefix = f"jobs/{burn_id}/out/"
        options = {"style": style, "karaoke": karaoke}
        if template is not None:
            options["template"] = template
        if canvas is not None:
            options["canvas"] = canvas
        api_db.execute(
            """INSERT INTO "Job" (id, "tenantId", kind, "parentJobId", "inputBucket", "inputKey", "originalFilename", "contentType",
                 "sizeBytes", "outputPrefix", options, "updatedAt")
               VALUES (%s, %s, 'BURN', %s, %s, %s, 'entrevista.mp4', 'video/mp4', %s, %s, %s::jsonb, now())""",
            (burn_id, DEFAULT_TENANT_ID, parent_id, config.s3_bucket, parent_payload["input"]["objectKey"], CLIP.stat().st_size, output_prefix, json.dumps(options)),
        )
        created.append(burn_id)
        payload = {
            "schemaVersion": 1,
            "jobId": burn_id,
            "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "input": {k: parent_payload["input"][k] for k in ("bucket", "objectKey")},
            "segments": {"bucket": config.s3_bucket, "objectKey": segments_key, "etag": etag},
            "outputPrefix": output_prefix,
            "options": options,
        }
        return burn_id, payload, etag

    yield make
    for burn_id in created:
        api_db.execute('DELETE FROM "Job" WHERE id = %s', (burn_id,))


def job_row(api_db, job_id: str) -> dict:
    cursor = api_db.execute(
        'SELECT status, stage, percent, message, "errorCode", "errorMessage", result, "startedAt", "finishedAt" FROM "Job" WHERE id = %s',
        (job_id,),
    )
    names = [column.name for column in cursor.description]
    return dict(zip(names, cursor.fetchone(), strict=True))


class FakeWhisper:
    """Sustituye a faster-whisper: mismos atributos que usa el worker, sin cargar ningún modelo."""

    def __init__(self, delay: float = 0.0, segments: int = 3) -> None:
        self.delay = delay
        self.segments = segments
        self.calls = 0
        self.paths: list[str] = []  # qué audio recibió cada llamada

    def transcribe(self, path: str, language=None, vad_filter=True, word_timestamps=True):  # noqa: ANN001
        self.calls += 1
        self.paths.append(path)
        info = SimpleNamespace(duration=self.segments * 3.0, language=language or "en")

        def generate():
            for i in range(self.segments):
                time.sleep(self.delay)
                word = SimpleNamespace(start=i * 3.0, end=i * 3.0 + 1.0, word=" Hola", probability=0.9)
                yield SimpleNamespace(start=i * 3.0, end=i * 3.0 + 2.5, text=f" Hola {i}", words=[word])

        return generate(), info


@pytest.fixture
def fake_models():
    whisper = FakeWhisper()
    provider = ModelProvider(loader=lambda size: (whisper, "cpu"), is_cached=lambda size: True)
    provider.whisper = whisper  # type: ignore[attr-defined]
    return provider


@pytest.fixture
def new_translate_job(api_db, storage: Storage, config: WorkerConfig, new_job, tmp_path):
    """Crea un trabajo TRANSLATE como lo haría el API: transcripción padre con su segments.json en S3 y la fila
    TRANSLATE en estado QUEUED. Devuelve (id, payload, etag)."""
    created: list[str] = []

    def make(
        *,
        provider: str = "argos",
        segments: list[dict] | None = None,
        source: str = "en",
        target: str = "es",
        upload_segments: bool = True,
    ) -> tuple[str, dict, str]:
        parent_id, parent_payload = new_job(upload_input=False)
        job_id = str(uuid.uuid4())
        segments_key = f"{parent_payload['outputPrefix']}segments.json"
        etag = "0" * 32
        if upload_segments:
            path = tmp_path / f"{job_id}.json"
            path.write_bytes(json.dumps(sample_segments() if segments is None else segments).encode())
            etag = storage.upload_file(path, segments_key, "application/json")
        output_prefix = f"jobs/{job_id}/out/"
        options = {"provider": provider, "sourceLanguage": source, "targetLanguage": target}
        api_db.execute(
            """INSERT INTO "Job" (id, "tenantId", kind, "parentJobId", "inputBucket", "inputKey", "originalFilename", "contentType",
                 "sizeBytes", "outputPrefix", options, "updatedAt")
               VALUES (%s, %s, 'TRANSLATE', %s, %s, %s, 'entrevista.mp4', 'video/mp4', 1, %s, %s::jsonb, now())""",
            (job_id, DEFAULT_TENANT_ID, parent_id, config.s3_bucket, parent_payload["input"]["objectKey"], output_prefix, json.dumps(options)),
        )
        created.append(job_id)
        payload = {
            "schemaVersion": 1,
            "jobId": job_id,
            "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "segments": {"bucket": config.s3_bucket, "objectKey": segments_key, "etag": etag},
            "outputPrefix": output_prefix,
            "options": options,
        }
        return job_id, payload, etag

    yield make
    for job_id in created:
        api_db.execute('DELETE FROM "Job" WHERE id = %s', (job_id,))


@pytest.fixture
def new_dub_job(api_db, storage: Storage, config: WorkerConfig, new_job, tmp_path):
    """Crea un trabajo DUB como lo haría el API: transcripción padre con su video y su segments.json en S3 y la fila DUB QUEUED.
    Devuelve (id, payload, etag)."""
    created: list[str] = []

    def make(
        *,
        provider: str = "openai",
        voice: str = "alloy",
        mix: str = "none",
        segments: list[dict] | None = None,
        upload_video: bool = True,
        upload_segments: bool = True,
    ) -> tuple[str, dict, str]:
        parent_id, parent_payload = new_job(upload_input=upload_video)
        job_id = str(uuid.uuid4())
        segments_key = f"{parent_payload['outputPrefix']}segments.json"
        etag = "0" * 32
        if upload_segments:
            path = tmp_path / f"{job_id}.json"
            path.write_bytes(json.dumps(sample_segments(words=False) if segments is None else segments).encode())
            etag = storage.upload_file(path, segments_key, "application/json")
        output_prefix = f"jobs/{job_id}/out/"
        options = {"provider": provider, "voice": voice, "mix": mix}
        api_db.execute(
            """INSERT INTO "Job" (id, "tenantId", kind, "parentJobId", "inputBucket", "inputKey", "originalFilename", "contentType",
                 "sizeBytes", "outputPrefix", options, "updatedAt")
               VALUES (%s, %s, 'DUB', %s, %s, %s, 'entrevista.mp4', 'video/mp4', %s, %s, %s::jsonb, now())""",
            (job_id, DEFAULT_TENANT_ID, parent_id, config.s3_bucket, parent_payload["input"]["objectKey"], CLIP.stat().st_size, output_prefix, json.dumps(options)),
        )
        created.append(job_id)
        payload = {
            "schemaVersion": 1,
            "jobId": job_id,
            "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "input": {k: parent_payload["input"][k] for k in ("bucket", "objectKey")},
            "segments": {"bucket": config.s3_bucket, "objectKey": segments_key, "etag": etag},
            "outputPrefix": output_prefix,
            "options": options,
        }
        return job_id, payload, etag

    yield make
    for job_id in created:
        api_db.execute('DELETE FROM "Job" WHERE id = %s', (job_id,))
