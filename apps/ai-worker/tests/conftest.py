"""Fixtures comunes. Las pruebas de integración usan PostgreSQL, Redis y S3 REALES (`npm run infra:up`
y la migración aplicada) y ffmpeg real; solo Whisper se simula, porque cargar un modelo en cada
ejecución no aporta nada al contrato que se prueba aquí."""

from __future__ import annotations

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


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.fail(f"Falta {name}: ejecuta las pruebas con `node scripts/test.mjs` (carga el .env).", pytrace=False)
    return value


@pytest.fixture(scope="session")
def config(tmp_path_factory: pytest.TempPathFactory) -> WorkerConfig:
    base = WorkerConfig.from_env({**os.environ, "WORK_DIR": str(tmp_path_factory.mktemp("work"))})
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
            """INSERT INTO "Job" (id, kind, "inputBucket", "inputKey", "originalFilename", "contentType",
                 "sizeBytes", "outputPrefix", options, "updatedAt")
               VALUES (%s, 'TRANSCRIBE', %s, %s, %s, 'video/mp4', %s, %s, %s::jsonb, now())""",
            (job_id, config.s3_bucket, input_key, filename, CLIP.stat().st_size, output_prefix, __import__("json").dumps(merged)),
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

    def transcribe(self, path: str, language=None, vad_filter=True, word_timestamps=True):  # noqa: ANN001
        self.calls += 1
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
