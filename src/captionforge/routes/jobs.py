"""GET /api/jobs/{id} - job status snapshot, and /events - the same shape over SSE."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..deps import get_job_store
from ..jobs import Job, JobStore, UnknownJobError
from ..pipeline import read_segments_json

router = APIRouter()

_TERMINAL_STATUSES = {"done", "burned", "error"}
_POLL_INTERVAL_SECONDS = 0.25


def _karaoke_available(job: Job) -> bool:
    """Whether at least one segment still carries word-level timing (untouched by translation/an edit)."""
    if not job.srt_ready or job.srt_path is None:
        return False
    try:
        return any(segment.words for segment in read_segments_json(job.srt_path.parent))
    except (FileNotFoundError, ValueError):
        return False


def _job_to_dict(job: Job) -> dict:
    return {
        "job_id": job.id,
        "status": job.status.value,
        "progress": job.progress,
        "stage_label": job.stage_label,
        "error": job.error,
        "srt_ready": job.srt_ready,
        "video_ready": job.video_ready,
        "karaoke_available": _karaoke_available(job),
    }


@router.get("/api/jobs/{job_id}")
async def get_job(job_id: str, store: JobStore = Depends(get_job_store)):
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    return _job_to_dict(job)


@router.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, store: JobStore = Depends(get_job_store)):
    async def event_stream():
        last_sent: dict | None = None
        while True:
            try:
                job = store.get(job_id)
            except UnknownJobError:
                yield f"event: error\ndata: {json.dumps({'error': 'job no encontrado'})}\n\n"
                return

            payload = _job_to_dict(job)
            if payload != last_sent:
                yield f"data: {json.dumps(payload)}\n\n"
                last_sent = payload

            if job.status.value in _TERMINAL_STATUSES:
                return
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
