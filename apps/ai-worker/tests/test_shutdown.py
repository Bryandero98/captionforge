"""Apagado ordenado del worker y limpieza de la carpeta de trabajo al arrancar.

Contra PostgreSQL, Redis, S3 y ffmpeg reales; solo Whisper se simula."""

from __future__ import annotations

import asyncio
import dataclasses
import time
import uuid
from types import SimpleNamespace

from ai_worker.db import JobRepository
from ai_worker.models import ModelProvider
from ai_worker.workdir import clean_stale_work
from ai_worker.worker import AiWorker

from conftest import FakeWhisper, job_row
from test_worker_queue import TERMINAL, enqueue, isolated, wait_for


def slow_models(delay: float, segments: int) -> ModelProvider:
    return ModelProvider(loader=lambda size: (FakeWhisper(delay=delay, segments=segments), "cpu"), is_cached=lambda size: True)


def test_stop_gives_a_running_job_a_grace_period_and_then_closes_it_cleanly(config, new_job, api_db) -> None:  # noqa: ANN001
    cfg = dataclasses.replace(isolated(config), shutdown_grace_seconds=1.0)
    job_id, payload = new_job()

    async def go() -> tuple[dict, float]:
        worker = AiWorker(cfg, models=slow_models(delay=0.5, segments=60))  # 30 s de trabajo
        await worker.start()
        queue = await enqueue(cfg, payload)
        try:
            await wait_for(api_db, job_id, until=lambda r: r["stage"] == "transcribing")
            started = time.monotonic()
            await worker.stop()
            elapsed = time.monotonic() - started
            return await wait_for(api_db, job_id, until=lambda r: r["status"] in TERMINAL, timeout=5), elapsed
        finally:
            await queue.close()

    row, elapsed = asyncio.run(go())
    assert elapsed < 12, f"stop() debe acabar poco después del plazo de gracia, no esperar los 30 s del trabajo ({elapsed:.1f} s)"
    assert row["status"] == "FAILED" and row["errorCode"] == "INTERNAL"
    assert "se apagó" in row["errorMessage"] and "cancel" not in row["errorMessage"].lower()
    assert not (cfg.work_dir / job_id).exists(), "no deben quedar archivos del trabajo en el disco"


def test_a_job_that_finishes_within_the_grace_period_completes_normally(config, new_job, api_db) -> None:  # noqa: ANN001
    cfg = dataclasses.replace(isolated(config), shutdown_grace_seconds=30.0)
    job_id, payload = new_job()

    async def go() -> dict:
        worker = AiWorker(cfg, models=slow_models(delay=0.3, segments=4))  # ~1,2 s
        await worker.start()
        queue = await enqueue(cfg, payload)
        try:
            await wait_for(api_db, job_id, until=lambda r: r["stage"] == "transcribing")
            await worker.stop()
            return job_row(api_db, job_id)
        finally:
            await queue.close()

    assert asyncio.run(go())["status"] == "COMPLETED"


def test_a_job_taken_from_the_queue_after_stop_is_not_started(config, new_job, api_db, fake_models) -> None:  # noqa: ANN001
    cfg = isolated(config)
    job_id, payload = new_job()
    job = SimpleNamespace(id=job_id, data=payload)

    async def go() -> None:
        worker = AiWorker(cfg, models=fake_models)
        worker._stopping = True  # el apagado empezó mientras este trabajo esperaba el hueco
        try:
            await worker.process(job, "token", SimpleNamespace(wait=asyncio.Event().wait))
        except Exception as error:  # noqa: BLE001 - se espera: BullMQ lo marca como fallido
            assert "antes de empezar" in str(error)
        else:
            raise AssertionError("debía rechazar el trabajo")
        finally:
            await asyncio.to_thread(worker.repo.close)

    asyncio.run(go())
    row = job_row(api_db, job_id)
    assert row["status"] == "FAILED" and row["errorCode"] == "INTERNAL"
    assert "antes de empezar" in row["errorMessage"]
    assert fake_models.whisper.calls == 0


class TestCleanStaleWork:
    def _make_job_dir(self, work_dir, job_id: str) -> None:  # noqa: ANN001
        folder = work_dir / job_id
        folder.mkdir(parents=True)
        (folder / "input.bin").write_bytes(b"x" * 1024)

    def test_removes_only_the_leftovers_of_jobs_that_are_not_alive(self, config, new_job, api_db, tmp_path) -> None:  # noqa: ANN001
        done, _ = new_job()
        alive, _ = new_job()
        stale, _ = new_job()
        unknown = str(uuid.uuid4())
        api_db.execute("UPDATE \"Job\" SET status = 'COMPLETED' WHERE id = %s", (done,))
        api_db.execute("UPDATE \"Job\" SET status = 'RUNNING', \"updatedAt\" = now() WHERE id = %s", (alive,))
        api_db.execute("UPDATE \"Job\" SET status = 'RUNNING', \"updatedAt\" = now() - interval '10 minutes' WHERE id = %s", (stale,))
        for job_id in (done, alive, stale, unknown):
            self._make_job_dir(tmp_path, job_id)
        (tmp_path / "modelos").mkdir()  # no es un id de trabajo: no se toca
        (tmp_path / "notas.txt").write_text("hola")

        repo = JobRepository(config.database_url)
        try:
            removed = asyncio.run(clean_stale_work(tmp_path, repo, live_within_seconds=180))
        finally:
            repo.close()

        assert removed == 3
        assert sorted(p.name for p in tmp_path.iterdir()) == sorted([alive, "modelos", "notas.txt"])

    def test_a_missing_work_dir_is_not_an_error(self, config, tmp_path) -> None:  # noqa: ANN001
        repo = JobRepository(config.database_url)
        try:
            assert asyncio.run(clean_stale_work(tmp_path / "no-existe", repo, live_within_seconds=180)) == 0
        finally:
            repo.close()
