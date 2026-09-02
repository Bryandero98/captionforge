"""GET /api/jobs/{id}/srt|vtt|ass|video|segments, PUT .../segments, POST .../burn (on demand)."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import replace
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from ..config import Settings
from ..deps import get_job_store, get_settings
from ..ffmpeg_utils import DEFAULT_STYLE_PRESET, resolve_style
from ..jobs import Job, JobStatus, JobStore, UnknownJobError
from ..pipeline import read_segments_json, run_burn_job, write_segments_json
from ..srt import segments_to_ass, segments_to_srt, segments_to_vtt

router = APIRouter()


def _validate_job_id(job_id: str) -> None:
    """Job ids are always uuid4 strings (see jobs.py). Anything else must never reach a filesystem path."""
    try:
        uuid.UUID(job_id)
    except ValueError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc


def _job_dir_for_id(job_id: str, settings: Settings) -> Path:
    return settings.jobs_dir / job_id


def _current_job_or_none(job_id: str, store: JobStore) -> Job | None:
    try:
        return store.get(job_id)
    except UnknownJobError:
        return None


def _resolve_srt_readiness(job_id: str, store: JobStore, settings: Settings) -> tuple[Path, bool]:
    """Returns (srt_path, ready) for either the current job (JobStore flag) or a past one (disk).

    A job that is NOT the one JobStore currently tracks can only be a job
    that already finished: CaptionForge processes one job at a time by
    design (JobConflictError blocks a new upload while one is active), so by
    construction any older job_id reached a terminal status before a new one
    could ever be created - checking file existence directly is safe there.
    The current job's OWN files can still be mid-write, so it keeps using the
    JobStore-tracked flag instead.
    """
    current = _current_job_or_none(job_id, store)
    if current is not None:
        return current.srt_path, current.srt_ready
    _validate_job_id(job_id)
    srt_path = _job_dir_for_id(job_id, settings) / "output.srt"
    return srt_path, srt_path.exists()


def _resolve_video_readiness(job_id: str, store: JobStore, settings: Settings) -> tuple[Path, bool]:
    current = _current_job_or_none(job_id, store)
    if current is not None:
        return current.captioned_path, current.video_ready
    _validate_job_id(job_id)
    captioned_path = _job_dir_for_id(job_id, settings) / "captioned.mp4"
    return captioned_path, captioned_path.exists()


@router.get("/api/jobs/{job_id}/srt")
async def get_srt(
    job_id: str, store: JobStore = Depends(get_job_store), settings: Settings = Depends(get_settings)
):
    srt_path, ready = _resolve_srt_readiness(job_id, store, settings)
    if not ready or srt_path is None or not srt_path.exists():
        raise HTTPException(404, "El .srt todavia no esta listo.")
    return FileResponse(srt_path, media_type="application/x-subrip", filename=f"{job_id}.srt")


@router.get("/api/jobs/{job_id}/vtt")
async def get_vtt(
    job_id: str, store: JobStore = Depends(get_job_store), settings: Settings = Depends(get_settings)
):
    srt_path, ready = _resolve_srt_readiness(job_id, store, settings)
    if not ready:
        raise HTTPException(404, "El .vtt todavia no esta listo.")
    segments_dir = srt_path.parent
    try:
        segments = await asyncio.to_thread(read_segments_json, segments_dir)
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise HTTPException(404, "El .vtt todavia no esta listo.") from exc
    return PlainTextResponse(
        segments_to_vtt(segments),
        media_type="text/vtt",
        headers={"Content-Disposition": f'attachment; filename="{job_id}.vtt"'},
    )


@router.get("/api/jobs/{job_id}/ass")
async def get_ass(
    job_id: str,
    style: str = DEFAULT_STYLE_PRESET,
    store: JobStore = Depends(get_job_store),
    settings: Settings = Depends(get_settings),
):
    srt_path, ready = _resolve_srt_readiness(job_id, store, settings)
    if not ready:
        raise HTTPException(404, "El .ass todavia no esta listo.")
    segments_dir = srt_path.parent
    try:
        segments = await asyncio.to_thread(read_segments_json, segments_dir)
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise HTTPException(404, "El .ass todavia no esta listo.") from exc
    return PlainTextResponse(
        segments_to_ass(segments, resolve_style(style)),
        media_type="text/x-ssa",
        headers={"Content-Disposition": f'attachment; filename="{job_id}.ass"'},
    )


def _segments_to_response(segments: list) -> dict:
    return {
        "segments": [
            {"index": index, "start": s.start, "end": s.end, "text": s.text}
            for index, s in enumerate(segments)
        ]
    }


@router.get("/api/jobs/{job_id}/segments")
async def get_segments(job_id: str, store: JobStore = Depends(get_job_store)):
    """Editable segment list for the CURRENT job only - see PUT for why editing isn't offered on old jobs."""
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if not job.srt_ready or job.srt_path is None:
        raise HTTPException(404, "La transcripcion todavia no esta lista.")
    segments = await asyncio.to_thread(read_segments_json, job.srt_path.parent)
    return _segments_to_response(segments)


@router.put("/api/jobs/{job_id}/segments")
async def update_segments(job_id: str, body: dict, store: JobStore = Depends(get_job_store)):
    """Applies text edits to the CURRENT job's segments, rewriting both segments.json and the .srt.

    Restricted to the current job by design: burning again after a job has
    already reached BURNED isn't a supported transition (see jobs.py's state
    machine) - editing only makes sense in the natural window between
    transcription finishing and the first burn, which is exactly when a job
    is still the one JobStore tracks.

    Editing a segment's text invalidates its word-level timing for karaoke
    (the edited words no longer line up with the original per-word
    timestamps) - `words` is dropped for any segment whose text actually
    changed, same rule translate.py applies for a translated segment.
    """
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if not job.srt_ready or job.srt_path is None:
        raise HTTPException(409, "La transcripcion todavia no esta lista para editar.")

    edits_by_index = {}
    for edit in body.get("segments", []):
        try:
            edits_by_index[int(edit["index"])] = str(edit["text"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(400, "Cada edicion necesita 'index' (numero) y 'text' (texto).") from exc

    segments = await asyncio.to_thread(read_segments_json, job.srt_path.parent)
    updated = []
    for index, segment in enumerate(segments):
        if index in edits_by_index:
            new_text = edits_by_index[index].strip()
            if new_text != segment.text.strip():
                segment = replace(segment, text=new_text, words=None)
        updated.append(segment)

    await asyncio.to_thread(write_segments_json, job.srt_path.parent, updated)
    await asyncio.to_thread(job.srt_path.write_text, segments_to_srt(updated), encoding="utf-8")
    return _segments_to_response(updated)


@router.post("/api/jobs/{job_id}/burn", status_code=202)
async def burn_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    style: str = Form(DEFAULT_STYLE_PRESET),
    karaoke: bool = Form(False),
    store: JobStore = Depends(get_job_store),
):
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if job.status != JobStatus.DONE:
        raise HTTPException(409, "El trabajo debe estar transcrito (DONE) antes de quemar subtitulos.")
    if job.video_path is None or job.srt_path is None or job.captioned_path is None:
        raise HTTPException(500, "Rutas del job incompletas.")

    background_tasks.add_task(
        run_burn_job, store, job.id, job.video_path, job.srt_path, job.captioned_path, style, karaoke
    )
    return {"job_id": job.id, "status": "burning_subtitles"}


@router.get("/api/jobs/{job_id}/video")
async def get_video(
    job_id: str, store: JobStore = Depends(get_job_store), settings: Settings = Depends(get_settings)
):
    captioned_path, ready = _resolve_video_readiness(job_id, store, settings)
    if not ready or captioned_path is None or not captioned_path.exists():
        raise HTTPException(404, "El video con subtitulos todavia no esta listo.")
    return FileResponse(captioned_path, media_type="video/mp4", filename=f"{job_id}_captioned.mp4")
