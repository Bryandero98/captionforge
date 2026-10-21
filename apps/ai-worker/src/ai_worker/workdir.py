"""Limpieza de la carpeta de trabajo: los restos de un proceso que murió (OOM, corte, SIGKILL) no se borran
solos, y cada trabajo deja videos de hasta 4 GiB."""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
from pathlib import Path

from .db import JobRepository

log = logging.getLogger("ai_worker")

_JOB_DIR = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


async def clean_stale_work(work_dir: Path, repo: JobRepository, *, live_within_seconds: float) -> int:
    """Borra las carpetas `<jobId>/` de `work_dir` cuyo trabajo ya no está vivo. Devuelve cuántas borró.

    Vivo = RUNNING con latido reciente: otra réplica puede compartir el volumen, y su trabajo en curso renueva
    `updatedAt` en cada latido. Solo toca carpetas cuyo nombre es un UUID: lo demás (modelos, notas) se respeta.
    """
    if not work_dir.is_dir():
        return 0
    candidates = [p for p in work_dir.iterdir() if p.is_dir() and _JOB_DIR.fullmatch(p.name)]
    if not candidates:
        return 0
    alive = await repo.live_job_ids([p.name for p in candidates], live_within_seconds)
    removed = 0
    for folder in candidates:
        if folder.name in alive:
            continue
        await asyncio.to_thread(shutil.rmtree, folder, True)
        removed += 1
    if removed:
        log.info("limpieza de %s: %d carpeta(s) de trabajos que ya no están en curso", work_dir, removed)
    return removed
