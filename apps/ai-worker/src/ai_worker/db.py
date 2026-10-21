"""Acceso a PostgreSQL con el rol cf_worker: solo lee y actualiza columnas concretas de "Job".

Se usa psycopg SÍNCRONO dentro de hilos (asyncio.to_thread): el modo asíncrono de psycopg no
funciona con el bucle por defecto de Windows, donde se desarrolla. Cada operación es una sentencia
con autocommit: la conexión nunca queda "idle in transaction" mientras ffmpeg o Whisper trabajan
horas (cf_worker tiene idle_in_transaction_session_timeout = 30 s, ver ADR 0006).
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

# La API (Prisma) guarda las fechas como TIMESTAMP sin zona, en UTC.
_NOW = "(now() AT TIME ZONE 'UTC')"
_ATTEMPTS = 4


class JobRepository:
    def __init__(self, database_url: str) -> None:
        self._url = database_url
        self._conn: psycopg.Connection | None = None
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            if self._conn is not None and not self._conn.closed:
                self._conn.close()
            self._conn = None

    def _execute_sync(self, sql: str, params: tuple[Any, ...]) -> int:
        with self._lock:
            for attempt in range(1, _ATTEMPTS + 1):
                try:
                    if self._conn is None or self._conn.closed:
                        self._conn = psycopg.connect(
                            self._url,
                            autocommit=True,
                            connect_timeout=10,
                            # Una consulta no puede quedarse colgada para siempre ni con la red cortada sin aviso
                            # (sin esto, un corte mudo bloquea el candado de esta clase y el hueco único del worker).
                            options="-c statement_timeout=30000",
                            keepalives=1,
                            keepalives_idle=30,
                            keepalives_interval=10,
                            keepalives_count=3,
                            tcp_user_timeout=30000,
                        )
                    return self._conn.execute(sql, params).rowcount
                except psycopg.OperationalError:
                    # La conexión se cayó (reinicio de PostgreSQL, red): se reconecta y se reintenta con espera
                    # creciente. Un reinicio de unos segundos no debe costar el resultado de horas de cómputo.
                    if self._conn is not None:
                        self._conn.close()
                    self._conn = None
                    if attempt == _ATTEMPTS:
                        raise
                    time.sleep(min(2**attempt, 10))
        raise AssertionError("inalcanzable")

    async def _execute(self, sql: str, *params: Any) -> int:
        return await asyncio.to_thread(self._execute_sync, sql, params)

    async def claim(self, job_id: str) -> bool:
        """QUEUED -> RUNNING. False si el trabajo ya no está en cola (p. ej. lo canceló la API)."""
        rows = await self._execute(
            f"""UPDATE "Job" SET status = 'RUNNING', "startedAt" = {_NOW}, "updatedAt" = {_NOW}
                WHERE id = %s AND status = 'QUEUED'""",
            job_id,
        )
        return rows == 1

    async def report(self, job_id: str, stage: str, percent: float, message: str | None) -> bool:
        """Progreso. False si el trabajo ya no está RUNNING."""
        rows = await self._execute(
            f"""UPDATE "Job" SET stage = %s, percent = %s, message = %s, "updatedAt" = {_NOW}
                WHERE id = %s AND status = 'RUNNING'""",
            stage,
            percent,
            message,
            job_id,
        )
        return rows == 1

    async def touch(self, job_id: str) -> bool:
        """Latido: renueva updatedAt. False si el trabajo ya no está RUNNING (lo cerró otro: API o recolector)."""
        rows = await self._execute(
            f"""UPDATE "Job" SET "updatedAt" = {_NOW} WHERE id = %s AND status = 'RUNNING'""", job_id
        )
        return rows == 1

    async def complete(self, job_id: str, result: dict[str, Any]) -> bool:
        rows = await self._execute(
            f"""UPDATE "Job" SET status = 'COMPLETED', percent = 100, stage = NULL, message = NULL,
                  result = %s, "finishedAt" = {_NOW}, "updatedAt" = {_NOW}
                WHERE id = %s AND status = 'RUNNING'""",
            Jsonb(result),
            job_id,
        )
        return rows == 1

    async def fail(self, job_id: str, code: str, message: str, *, cancelled: bool = False) -> bool:
        """Cierra el trabajo como FAILED o CANCELLED. No toca trabajos que ya terminaron."""
        rows = await self._execute(
            f"""UPDATE "Job" SET status = %s, "errorCode" = %s, "errorMessage" = %s,
                  "finishedAt" = {_NOW}, "updatedAt" = {_NOW}
                WHERE id = %s AND status IN ('QUEUED', 'RUNNING')""",
            "CANCELLED" if cancelled else "FAILED",
            code,
            message,
            job_id,
        )
        return rows == 1
