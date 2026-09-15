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
from ..srt import WordTiming, redistribute_word_timings, segments_to_ass, segments_to_srt, segments_to_vtt
from ..waveform import WaveformExtractionError, compute_waveform_peaks

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


def _resolve_srt_readiness(job_id: str, store: JobStore, settings: Settings) -> tuple[Path | None, bool]:
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


def _resolve_video_readiness(job_id: str, store: JobStore, settings: Settings) -> tuple[Path | None, bool]:
    current = _current_job_or_none(job_id, store)
    if current is not None:
        return current.captioned_path, current.video_ready
    _validate_job_id(job_id)
    captioned_path = _job_dir_for_id(job_id, settings) / "captioned.mp4"
    return captioned_path, captioned_path.exists()


def _resolve_input_video_path(job_id: str, store: JobStore, settings: Settings) -> Path | None:
    """Finds the ORIGINAL uploaded video (not the captioned/burned output) for the waveform endpoint.

    The current job's own path is on the Job object already
    (`upload.py` names it `input{suffix}`, suffix depending on what was
    uploaded); an older job's isn't tracked anywhere in memory, so it's
    globbed straight off disk the same way `_resolve_srt_readiness` and
    `_resolve_video_readiness` already read an old job's other files - safe
    for the same reason those are: CaptionForge's one-job-at-a-time design
    guarantees any older job_id already reached a terminal status.
    """
    current = _current_job_or_none(job_id, store)
    if current is not None:
        return current.video_path
    _validate_job_id(job_id)
    job_dir = _job_dir_for_id(job_id, settings)
    if not job_dir.exists():
        return None
    return next(iter(sorted(job_dir.glob("input.*"))), None)


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
    if not ready or srt_path is None:
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
    if not ready or srt_path is None:
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


def _words_to_response(words: list[WordTiming] | None) -> list[dict] | None:
    """Per-word timing + confidence for the editor's low-confidence highlighting (see app.js).

    `probability` is `None` for a word this app synthesized itself (a
    translated or manually-edited segment's approximate, redistributed
    timing - see `redistribute_word_timings`) rather than one faster-whisper
    actually recognized - the frontend must never highlight those as
    "low confidence", since there's no real recognition score behind them.
    """
    if not words:
        return None
    return [{"start": w.start, "end": w.end, "text": w.text, "probability": w.probability} for w in words]


def _segments_to_response(segments: list) -> dict:
    return {
        "segments": [
            {
                "index": index,
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "words": _words_to_response(s.words),
            }
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


@router.get("/api/jobs/{job_id}/waveform")
async def get_waveform(
    job_id: str,
    store: JobStore = Depends(get_job_store),
    settings: Settings = Depends(get_settings),
):
    """Downsampled amplitude data for the segment editor's waveform backdrop (see waveform.py).

    Works for the current job AND an older one still on disk (same
    disk-existence fallback posture as srt/vtt/ass/video above) - the
    waveform only ever needs the original video file, not JobStore's
    in-memory state, so there's no reason to restrict it to the current job
    the way segment editing itself is restricted.
    """
    video_path = _resolve_input_video_path(job_id, store, settings)
    if video_path is None or not video_path.exists():
        raise HTTPException(404, "El video de este job no esta disponible.")
    try:
        peaks, duration = await asyncio.to_thread(compute_waveform_peaks, video_path)
    except WaveformExtractionError as exc:
        raise HTTPException(500, str(exc)) from exc
    return {"peaks": peaks, "duration": duration}


@router.put("/api/jobs/{job_id}/segments")
async def update_segments(job_id: str, body: dict, store: JobStore = Depends(get_job_store)):
    """Applies text/timing edits to the CURRENT job's segments, rewriting segments.json and the .srt.

    Restricted to the current job by design: burning again after a job has
    already reached BURNED isn't a supported transition (see jobs.py's state
    machine) - editing only makes sense in the natural window between
    transcription finishing and the first burn, which is exactly when a job
    is still the one JobStore tracks.

    Each edit's 'text', 'start', and 'end' are all optional - the frontend's
    waveform editor sends 'start'/'end' alone for a pure timing drag, its
    text inputs send 'text' alone, and either can be omitted to leave that
    field untouched. Editing a segment's TEXT invalidates its real per-word
    timing for karaoke (the edited words no longer line up with the original
    per-word timestamps) - rather than dropping word-level timing outright,
    it's approximated via `redistribute_word_timings` (same heuristic
    translate.py uses for a translated segment): the segment's [start, end)
    span divided across the new text's words by character length. Editing
    ONLY the timing (text unchanged) keeps whatever word timing the segment
    already had - real or previously-approximated - since the words
    themselves didn't change, only where the segment starts/ends.
    """
    try:
        job = store.get(job_id)
    except UnknownJobError as exc:
        raise HTTPException(404, "Job no encontrado.") from exc
    if not job.srt_ready or job.srt_path is None:
        raise HTTPException(409, "La transcripcion todavia no esta lista para editar.")

    edits_by_index: dict[int, dict] = {}
    for edit in body.get("segments", []):
        try:
            index = int(edit["index"])
            entry: dict = {}
            if "text" in edit:
                entry["text"] = str(edit["text"])
            if "start" in edit:
                entry["start"] = float(edit["start"])
            if "end" in edit:
                entry["end"] = float(edit["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                400,
                "Cada edicion necesita 'index' (numero) y, opcionalmente, 'text' (texto), "
                "'start'/'end' (numeros).",
            ) from exc
        edits_by_index[index] = entry

    segments = await asyncio.to_thread(read_segments_json, job.srt_path.parent)
    updated = []
    for index, segment in enumerate(segments):
        edit = edits_by_index.get(index)
        if edit:
            new_start = edit.get("start", segment.start)
            new_end = edit.get("end", segment.end)
            if new_start < 0 or new_end <= new_start:
                raise HTTPException(
                    400, f"Tiempos invalidos para el segmento {index}: start={new_start}, end={new_end}."
                )
            new_text = edit["text"].strip() if "text" in edit else segment.text
            text_changed = new_text != segment.text.strip()
            words = redistribute_word_timings(new_text, new_start, new_end) if text_changed else segment.words
            segment = replace(segment, text=new_text, start=new_start, end=new_end, words=words)
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
