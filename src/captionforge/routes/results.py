"""GET /api/jobs/{id}/srt, POST /api/jobs/{id}/burn (on demand), GET /api/jobs/{id}/video."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse

from ..deps import get_job_store
from ..jobs import JobStatus, JobStore, UnknownJobError
from ..pipeline import run_burn_job

router = APIRouter()


@router.get("/api/jobs/{job_id}/srt")
async def get_srt(job_id: str, store: JobStore = Depends(get_job_store)):
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if not job.srt_ready or job.srt_path is None or not job.srt_path.exists():
        raise HTTPException(404, "El .srt todavia no esta listo.")
    return FileResponse(job.srt_path, media_type="application/x-subrip", filename=f"{job_id}.srt")


@router.post("/api/jobs/{job_id}/burn", status_code=202)
async def burn_job(job_id: str, background_tasks: BackgroundTasks, store: JobStore = Depends(get_job_store)):
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if job.status != JobStatus.DONE:
        raise HTTPException(409, "El trabajo debe estar transcrito (DONE) antes de quemar subtitulos.")
    if job.video_path is None or job.srt_path is None or job.captioned_path is None:
        raise HTTPException(500, "Rutas del job incompletas.")

    background_tasks.add_task(run_burn_job, store, job.id, job.video_path, job.srt_path, job.captioned_path)
    return {"job_id": job.id, "status": "burning_subtitles"}


@router.get("/api/jobs/{job_id}/video")
async def get_video(job_id: str, store: JobStore = Depends(get_job_store)):
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if not job.video_ready or job.captioned_path is None or not job.captioned_path.exists():
        raise HTTPException(404, "El video con subtitulos todavia no esta listo.")
    return FileResponse(job.captioned_path, media_type="video/mp4", filename=f"{job_id}_captioned.mp4")
