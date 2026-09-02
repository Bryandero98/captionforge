"""POST /api/jobs - upload a video and kick off transcription in the background."""

from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path
from typing import BinaryIO

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile

from ..config import Settings
from ..deps import get_job_store, get_settings
from ..jobs import JobConflictError, JobStore
from ..pipeline import run_transcription_job

router = APIRouter()

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}


def _save_upload(source: BinaryIO, dest: Path) -> None:
    """Copies the upload straight to disk in chunks - never holds the whole video in memory at once."""
    with dest.open("wb") as out:
        shutil.copyfileobj(source, out)


def _cleanup_old_jobs(jobs_dir: Path, keep_job_id: str, max_age_seconds: float) -> None:
    """Deletes job directories (video/srt/vtt/ass/segments.json) older than max_age_seconds.

    CaptionForge never deletes a job's files on its own otherwise - "recent
    jobs" history (frontend, localStorage) and the historical-download
    fallback (routes/results.py) both depend on them surviving after
    JobStore itself forgets a superseded job, so nothing else in the backend
    ever cleans them up. Run as a background task on every upload (not a
    scheduler/daemon) - a purely local, single-user tool doesn't need one,
    disk usage just self-limits to whatever was created in the retention
    window. `keep_job_id` is the job just created - always too young to
    match anyway, named explicitly so this never touches it even under a
    clock skew or a near-zero retention window.
    """
    if not jobs_dir.exists():
        return
    now = time.time()
    for entry in jobs_dir.iterdir():
        if not entry.is_dir() or entry.name == keep_job_id:
            continue
        try:
            age_seconds = now - entry.stat().st_mtime
        except OSError:
            continue
        if age_seconds > max_age_seconds:
            shutil.rmtree(entry, ignore_errors=True)


@router.post("/api/jobs", status_code=201)
async def create_job(
    background_tasks: BackgroundTasks,
    file: UploadFile,
    model_size: str | None = Form(None),
    language: str | None = Form(None),
    translate_to: str | None = Form(None),
    settings: Settings = Depends(get_settings),
    store: JobStore = Depends(get_job_store),
):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Formato de video no soportado: {suffix or '(sin extension)'}")

    try:
        job = store.create()
    except JobConflictError as exc:
        raise HTTPException(409, str(exc)) from exc

    # The web UI always sends model_size (its <select> has a default
    # option), so this fallback mainly serves callers hitting the API
    # directly without setting it - matches Settings.default_model_size's
    # own purpose as a server-wide default.
    model_size = model_size or settings.default_model_size

    job_dir = settings.jobs_dir / job.id
    job_dir.mkdir(parents=True, exist_ok=True)
    video_path = job_dir / f"input{suffix}"
    srt_path = job_dir / "output.srt"
    captioned_path = job_dir / "captioned.mp4"

    # Streamed straight to disk in a worker thread, never buffered whole into
    # process memory first (a multi-GB upload - the normal case for this app -
    # would otherwise spike RAM by its full size before a single byte hit
    # disk) - and running in a thread keeps the copy from stalling the event
    # loop (and with it the SSE progress stream of any other in-flight
    # request) for however long the disk write takes.
    await asyncio.to_thread(_save_upload, file.file, video_path)

    store.update(job.id, video_path=video_path, srt_path=srt_path, captioned_path=captioned_path)

    background_tasks.add_task(
        run_transcription_job,
        store,
        job.id,
        video_path,
        srt_path,
        model_size,
        language or None,
        translate_to or None,
    )
    background_tasks.add_task(
        _cleanup_old_jobs, settings.jobs_dir, job.id, settings.job_retention_days * 86400
    )

    return {"job_id": job.id, "status": job.status.value}
