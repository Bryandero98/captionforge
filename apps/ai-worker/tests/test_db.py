"""JobRepository contra PostgreSQL real, con el rol cf_worker (el mismo que usará en producción)."""

from __future__ import annotations

import asyncio

from ai_worker.db import JobRepository

from conftest import job_row


def repo(config) -> JobRepository:  # noqa: ANN001
    return JobRepository(config.database_url)


def test_full_lifecycle_with_conditional_transitions(config, new_job, api_db) -> None:  # noqa: ANN001
    job_id, _ = new_job(upload_input=False)
    r = repo(config)

    async def go() -> None:
        assert await r.claim(job_id) is True
        assert await r.claim(job_id) is False, "un segundo worker no puede tomar el mismo trabajo"
        assert await r.report(job_id, "transcribing", 42.5, "mitad") is True
        assert await r.complete(job_id, {"ok": True}) is True
        # Ya terminó: ni progreso, ni fallo, ni otro cierre pueden pisarlo.
        assert await r.report(job_id, "transcribing", 1, "x") is False
        assert await r.fail(job_id, "INTERNAL", "tarde") is False
        assert await r.complete(job_id, {"ok": False}) is False

    asyncio.run(go())
    r.close()
    row = job_row(api_db, job_id)
    assert row["status"] == "COMPLETED" and row["percent"] == 100 and row["result"] == {"ok": True}
    assert row["startedAt"] is not None and row["finishedAt"] is not None
    assert row["errorCode"] is None


def test_cancelled_while_queued_is_not_claimed(config, new_job, api_db) -> None:  # noqa: ANN001
    job_id, _ = new_job(upload_input=False)
    api_db.execute("UPDATE \"Job\" SET status = 'CANCELLED' WHERE id = %s", (job_id,))
    r = repo(config)
    assert asyncio.run(r.claim(job_id)) is False
    r.close()
    assert job_row(api_db, job_id)["status"] == "CANCELLED"


def test_fail_records_code_and_status(config, new_job, api_db) -> None:  # noqa: ANN001
    job_id, _ = new_job(upload_input=False)
    r = repo(config)

    async def go() -> None:
        assert await r.claim(job_id)
        assert await r.fail(job_id, "FFMPEG_FAILED", "no se pudo") is True

    asyncio.run(go())
    r.close()
    row = job_row(api_db, job_id)
    assert (row["status"], row["errorCode"], row["errorMessage"]) == ("FAILED", "FFMPEG_FAILED", "no se pudo")


def test_cancelled_flag_sets_cancelled_status(config, new_job, api_db) -> None:  # noqa: ANN001
    job_id, _ = new_job(upload_input=False)
    r = repo(config)

    async def go() -> None:
        await r.claim(job_id)
        await r.fail(job_id, "CANCELLED", "Cancelado", cancelled=True)

    asyncio.run(go())
    r.close()
    assert job_row(api_db, job_id)["status"] == "CANCELLED"


def test_reconnects_after_the_connection_is_killed(config, new_job, api_db) -> None:  # noqa: ANN001
    job_id, _ = new_job(upload_input=False)
    r = repo(config)

    async def go() -> None:
        assert await r.claim(job_id)
        # Mata la conexión desde fuera (como un reinicio de PostgreSQL o un corte de red).
        r._conn.execute("SELECT 1")  # type: ignore[union-attr]
        r._conn.close()  # type: ignore[union-attr]
        assert await r.report(job_id, "transcribing", 10, "tras la caída") is True

    asyncio.run(go())
    r.close()
    assert job_row(api_db, job_id)["message"] == "tras la caída"


def test_idle_connection_survives_longer_than_the_idle_in_transaction_timeout(config, new_job) -> None:  # noqa: ANN001
    """ADR 0006 regla 9: sin transacciones abiertas, una conexión quieta no la cierra el servidor."""
    job_id, _ = new_job(upload_input=False)
    r = repo(config)

    async def go() -> bool:
        await r.claim(job_id)
        await asyncio.sleep(35)  # idle_in_transaction_session_timeout del rol = 30 s
        return await r.report(job_id, "transcribing", 5, "sigo vivo")

    assert asyncio.run(go()) is True
    r.close()


def test_touch_only_renews_running_jobs(config, new_job, api_db) -> None:  # noqa: ANN001
    job_id, _ = new_job(upload_input=False)
    r = repo(config)

    async def go() -> tuple[bool, bool, bool]:
        before_claim = await r.touch(job_id)  # QUEUED: no es un latido válido
        await r.claim(job_id)
        api_db.execute("UPDATE \"Job\" SET \"updatedAt\" = now() - interval '30 minutes' WHERE id = %s", (job_id,))
        running = await r.touch(job_id)
        await r.complete(job_id, {})
        return before_claim, running, await r.touch(job_id)

    assert asyncio.run(go()) == (False, True, False)
    r.close()
    fresh = api_db.execute("SELECT now() - \"updatedAt\" < interval '1 minute' FROM \"Job\" WHERE id = %s", (job_id,)).fetchone()
    assert fresh is not None
