"""Orchestrates faster-whisper + ffmpeg for one job, reporting progress into a JobStore.

ffmpeg runs via asyncio.create_subprocess_exec (non-blocking). Whisper's
transcribe() and Argos's translate() are both blocking/CPU-bound - they run
in a worker thread via asyncio.to_thread so neither blocks the event loop
that also has to keep serving the SSE progress stream while they run.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from .ffmpeg_utils import build_burn_subtitles_cmd, build_extract_audio_cmd, resolve_style
from .jobs import JobStatus, JobStore
from .srt import Segment, WordTiming, segments_from_dicts, segments_to_ass, segments_to_dicts, segments_to_srt
from .translate import translate_segments

# Fixed filenames within a job's directory - shared by pipeline.py (writer)
# and routes/results.py (reader, including the historical-job fallback that
# reads them straight off disk without going through JobStore).
SEGMENTS_FILENAME = "segments.json"
KARAOKE_ASS_FILENAME = "karaoke.ass"


def write_segments_json(segments_dir: Path, segments: list[Segment]) -> None:
    (segments_dir / SEGMENTS_FILENAME).write_text(json.dumps(segments_to_dicts(segments)), encoding="utf-8")


def read_segments_json(segments_dir: Path) -> list[Segment]:
    raw = (segments_dir / SEGMENTS_FILENAME).read_text(encoding="utf-8")
    return segments_from_dicts(json.loads(raw))


def select_device(model_size: str) -> tuple[object, str]:
    """Tries GPU (cuda/float16) first, falls back cleanly to CPU (int8). Returns (model, device_used)."""
    from faster_whisper import WhisperModel

    try:
        return WhisperModel(model_size, device="cuda", compute_type="float16"), "cuda"
    except Exception:  # noqa: BLE001 - deliberately broad: any CUDA/cuDNN init failure should fall back to CPU, not crash
        return WhisperModel(model_size, device="cpu", compute_type="int8"), "cpu"


async def _run_ffmpeg(cmd: list[str]) -> None:
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg fallo (codigo {process.returncode}): {stderr.decode(errors='replace')}")


def _transcribe_sync(
    model: object,
    audio_path: Path,
    language: str | None,
    store: JobStore,
    job_id: str,
) -> tuple[list[Segment], str]:
    """Runs synchronously in a worker thread.

    Iterates Whisper's segment generator, updating JobStore progress after each one.
    """
    raw_segments, info = model.transcribe(  # type: ignore[attr-defined]
        str(audio_path), language=language, vad_filter=True, word_timestamps=True
    )

    segments: list[Segment] = []
    for raw in raw_segments:
        # word_timestamps=True makes faster-whisper return raw.start/raw.end
        # (and each word's start/end) as numpy.float64 instead of plain
        # float - verified live. Cast explicitly so Segment/progress stay
        # plain Python floats, matching Segment's own declared type and
        # keeping every value JSON-serializable once the API layer exists.
        start, end = float(raw.start), float(raw.end)
        progress = (end / info.duration) if info.duration else 0.0
        store.update(
            job_id,
            progress=progress,
            stage_label=f"Transcribiendo ({progress * 100:.0f}%)",
        )
        words = (
            [WordTiming(start=float(w.start), end=float(w.end), text=w.word) for w in raw.words]
            if raw.words
            else None
        )
        segments.append(Segment(start=start, end=end, text=raw.text, words=words))

    return segments, info.language


async def run_transcription_job(
    store: JobStore,
    job_id: str,
    video_path: Path,
    srt_path: Path,
    model_size: str = "small",
    language: str | None = None,
    translate_to: str | None = None,
) -> None:
    """Extracts audio, transcribes, optionally translates, and writes srt_path.

    Updates the job through EXTRACTING_AUDIO -> TRANSCRIBING -> DONE, or ERROR on failure.
    """
    try:
        store.transition(job_id, JobStatus.EXTRACTING_AUDIO)
        store.update(job_id, stage_label="Extrayendo audio")

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio_path = Path(tmp_dir) / "audio.wav"
            await _run_ffmpeg(build_extract_audio_cmd(str(video_path), str(audio_path)))

            store.transition(job_id, JobStatus.TRANSCRIBING)
            model, device = await asyncio.to_thread(select_device, model_size)
            store.update(job_id, stage_label=f"Modelo cargado en {device}")

            segments, detected_language = await asyncio.to_thread(
                _transcribe_sync, model, audio_path, language, store, job_id
            )
            # audio_path is removed automatically on exiting this `with`
            # block, even if transcription raises.

        if translate_to and translate_to != (language or detected_language):
            store.update(job_id, stage_label=f"Traduciendo a {translate_to}")
            segments = await asyncio.to_thread(
                translate_segments, segments, language or detected_language, translate_to
            )

        await asyncio.to_thread(srt_path.write_text, segments_to_srt(segments), encoding="utf-8")
        # Persisted alongside the .srt so /vtt, /ass, /segments (edit), and a
        # completed job's entry in the frontend's "recent jobs" history can
        # all read the full Segment list (word timings included) straight off
        # disk - independent of JobStore, which only ever remembers ONE job.
        await asyncio.to_thread(write_segments_json, srt_path.parent, segments)
        store.update(job_id, srt_ready=True, stage_label="Listo")
        store.transition(job_id, JobStatus.DONE)
    except Exception as exc:
        store.update(job_id, error=str(exc))
        store.transition(job_id, JobStatus.ERROR)
        raise


async def run_burn_job(
    store: JobStore,
    job_id: str,
    video_path: Path,
    srt_path: Path,
    output_path: Path,
    style_name: str = "modern",
    karaoke: bool = False,
) -> None:
    """Burns subtitles into video_path, writing output_path.

    Two render paths:
    - `karaoke=True` AND at least one segment still carries word timings
      (untouched by translation or a manual text edit - see translate.py and
      the segment-edit route) -> builds a per-word `\\k`-tagged .ass file
      (segments without words still render, just without the effect) and
      burns that, with `style_name` baked into its own Style: line.
    - Otherwise -> the original plain-SRT path, styled via `force_style`.

    Updates the job through BURNING_SUBTITLES -> BURNED, or ERROR on failure.
    """
    try:
        store.transition(job_id, JobStatus.BURNING_SUBTITLES)
        store.update(job_id, stage_label="Quemando subtitulos")

        segments = await asyncio.to_thread(read_segments_json, srt_path.parent)
        use_karaoke = karaoke and any(segment.words for segment in segments)

        if use_karaoke:
            ass_path = srt_path.parent / KARAOKE_ASS_FILENAME
            ass_content = segments_to_ass(segments, resolve_style(style_name))
            await asyncio.to_thread(ass_path.write_text, ass_content, encoding="utf-8")
            cmd = build_burn_subtitles_cmd(str(video_path), str(ass_path), str(output_path), is_ass=True)
        else:
            cmd = build_burn_subtitles_cmd(str(video_path), str(srt_path), str(output_path), style_name)

        await _run_ffmpeg(cmd)
        store.update(job_id, video_ready=True, stage_label="Listo")
        store.transition(job_id, JobStatus.BURNED)
    except Exception as exc:
        store.update(job_id, error=str(exc))
        store.transition(job_id, JobStatus.ERROR)
        raise
