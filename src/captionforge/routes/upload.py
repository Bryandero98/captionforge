"""POST /api/jobs - upload a video and kick off transcription in the background."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile

from ..config import Settings
from ..deps import get_job_store, get_settings
from ..jobs import JobConflictError, JobStore
from ..pipeline import run_transcription_job

router = APIRouter()

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}


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

    # The write itself runs entirely in a worker thread - a blocking
    # open()/write() straight in this async handler would stall the event
    # loop (and with it the SSE progress stream of any other in-flight
    # request) for however long the disk write takes.
    content = await file.read()
    await asyncio.to_thread(video_path.write_bytes, content)

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

    return {"job_id": job.id, "status": job.status.value}
