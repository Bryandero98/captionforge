"""Pipeline de transcripción: descarga el video, extrae el audio, transcribe, traduce y sube los
artefactos. Reutiliza los bloques puros del paquete heredado (ffmpeg, Whisper, traducción, SRT,
forma de onda) sin su `JobStore`.

Regla de oro (ADR 0006): nada pesado en el bucle de eventos. ffmpeg corre como subproceso asíncrono;
Whisper, la traducción, la forma de onda y las transferencias a S3 corren en hilos.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import shutil
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from captionforge.ffmpeg_utils import build_extract_audio_cmd
from captionforge.models import InsufficientDiskSpaceError
from captionforge.pipeline import _run_ffmpeg
from captionforge.srt import Segment, WordTiming, segments_to_dicts, segments_to_srt
from captionforge.translate import translate_segments
from captionforge.waveform import compute_waveform_peaks
from captionforge_contracts import TranscribeJob, TranscribeResult

from .config import WorkerConfig
from .errors import JobCancelled, JobFailure
from .models import ModelProvider
from .diarization import DiarizationFailed, Diarizer, SubprocessDiarizer, assign_speakers
from .progress import Progress, stage_ranges
from .separation import SeparationFailed, Separator, SubprocessSeparator
from .storage import Storage

log = logging.getLogger("ai_worker")


def _language(value: Any) -> str | None:
    """LanguageCode es un RootModel en los modelos generados."""
    return None if value is None else str(value.root)


@dataclass
class _Transcription:
    segments: list[Segment]
    language: str
    duration: float
    device: str


def _transcribe_sync(
    model: object,
    audio_path: Path,
    language: str | None,
    device: str,
    on_progress: Callable[[float], None],
    cancel: threading.Event,
) -> _Transcription:
    """Corre en un hilo. Revisa la cancelación entre segmentos (no se puede interrumpir uno a medias)."""
    raw_segments, info = model.transcribe(  # type: ignore[attr-defined]
        str(audio_path), language=language, vad_filter=True, word_timestamps=True
    )
    segments: list[Segment] = []
    for raw in raw_segments:
        if cancel.is_set():
            raise JobCancelled()
        # Con word_timestamps Whisper devuelve numpy.float64: se pasa a float para poder serializar.
        start, end = float(raw.start), float(raw.end)
        on_progress((end / info.duration) if info.duration else 0.0)
        words = (
            [
                WordTiming(start=float(w.start), end=float(w.end), text=w.word, probability=float(w.probability))
                for w in raw.words
            ]
            if raw.words
            else None
        )
        segments.append(Segment(start=start, end=end, text=raw.text, words=words))
    if cancel.is_set():
        raise JobCancelled()
    return _Transcription(segments, str(info.language), float(info.duration or 0.0), device)


class TranscribeRunner:
    def __init__(
        self,
        config: WorkerConfig,
        storage: Storage,
        models: ModelProvider,
        separator: Separator | None = None,
        diarizer: Diarizer | None = None,
    ) -> None:
        self._config = config
        self._storage = storage
        self._models = models
        self._separator = separator or SubprocessSeparator(
            stall_timeout=config.separation_stall_timeout, total_timeout=config.separation_total_timeout
        )
        self._diarizer = diarizer or SubprocessDiarizer(
            token=config.hf_token,
            stall_timeout=config.diarization_stall_timeout,
            total_timeout=config.diarization_total_timeout,
        )

    async def run(self, payload: TranscribeJob, progress: Progress, cancel: threading.Event) -> dict[str, Any]:
        """Devuelve el TranscribeResult (como dict JSON). Lanza JobCancelled o la excepción original."""
        job_id = str(payload.jobId)
        job_dir = self._config.work_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            return await self._run(payload, progress, cancel, job_dir)
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)  # los videos son grandes: nada queda en el disco

    @staticmethod
    def _check(cancel: threading.Event) -> None:
        if cancel.is_set():
            raise JobCancelled()

    async def _clean(self, audio: Path, job_dir: Path, progress: Progress, cancel: threading.Event) -> tuple[Path, bool]:
        """Devuelve (audio a transcribir, si es el limpio). Whisper se suelta ANTES de lanzar el separador: los dos
        modelos nunca conviven en la GPU. Un fallo de la separación no hace fallar el trabajo; una cancelación sí."""
        await asyncio.to_thread(self._models.release)
        cleaned = job_dir / "vocals.wav"

        async def report(stage: str, fraction: float) -> None:
            message = "Descargando el modelo de separación de voz" if stage == "downloading_separation_model" else f"Limpiando el audio ({fraction * 100:.0f}%)"
            await progress.report(stage, fraction, message)

        await progress.report("separating_voice", 0.0, "Limpiando el audio")
        try:
            await self._separator.separate(audio, cleaned, report)
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 - cualquier fallo de la separación (OOM, pesos, hijo) -> audio original
            self._check(cancel)  # si fue una cancelación, no se disfraza de fallo recuperable
            if isinstance(error, SeparationFailed):
                log.warning("separación de voz fallida; se usa el audio original: %s", error)
            else:
                log.warning("separación de voz fallida; se usa el audio original", exc_info=error)
            await progress.report("separating_voice", 1.0, "No se pudo limpiar el audio; se usa el original")
            return audio, False
        self._check(cancel)
        return cleaned, True

    async def _diarize(
        self, audio: Path, segments: list[Segment], progress: Progress, cancel: threading.Event
    ) -> tuple[list[Segment], bool]:
        """Devuelve (segmentos con hablante, si se identificó). Whisper se suelta ANTES de lanzar el hijo: los dos modelos
        nunca conviven en la GPU. Un fallo (sin token, descarga, tiempo, hijo) no hace fallar el trabajo: se entrega la
        transcripción normal; una cancelación sí lo cancela."""
        await asyncio.to_thread(self._models.release)

        async def report(stage: str, fraction: float) -> None:
            message = (
                "Descargando el modelo de identificación de hablantes"
                if stage == "downloading_diarization_model"
                else f"Identificando quién habla ({fraction * 100:.0f}%)"
            )
            await progress.report(stage, fraction, message)

        await progress.report("diarizing", 0.0, "Identificando quién habla")
        try:
            turns = await self._diarizer.diarize(audio, report)
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 - cualquier fallo (token, red, OOM, hijo) -> transcripción sin hablantes
            self._check(cancel)  # si fue una cancelación, no se disfraza de fallo recuperable
            if isinstance(error, DiarizationFailed):
                log.warning("identificación de hablantes fallida; se entrega la transcripción normal: %s", error)
            else:
                log.warning("identificación de hablantes fallida; se entrega la transcripción normal", exc_info=error)
            await progress.report("diarizing", 1.0, "No se pudo identificar quién habla; se entrega la transcripción normal")
            return segments, False
        self._check(cancel)
        return assign_speakers(segments, turns), True

    async def _run(self, payload: TranscribeJob, progress: Progress, cancel: threading.Event, job_dir: Path) -> dict[str, Any]:
        job_id = str(payload.jobId)
        size = str(payload.options.modelSize)
        source_language = _language(payload.options.sourceLanguage)
        translate_to = _language(payload.options.translateTo)
        prefix = payload.outputPrefix
        clean_audio = bool(payload.options.cleanAudio)
        diarize = bool(payload.options.diarize)
        if clean_audio or diarize:
            progress.use_ranges(stage_ranges(clean_audio, diarize))

        # 1. Entrada
        await progress.report("downloading_input", 0.0, "Descargando el video")
        video = job_dir / "input.bin"
        await asyncio.to_thread(self._storage.download, payload.input.bucket, payload.input.objectKey, video)
        self._check(cancel)

        # 2. Audio (subproceso asíncrono: cancelar la tarea mata a ffmpeg)
        await progress.report("extracting_audio", 0.0, "Extrayendo el audio")
        audio = job_dir / "audio.wav"
        await _run_ffmpeg(
            build_extract_audio_cmd(str(video), str(audio)),
            stall_timeout=self._config.ffmpeg_stall_timeout,
            total_timeout=self._config.ffmpeg_total_timeout,
        )
        self._check(cancel)

        # 2b. Aislar la voz (opcional). Si falla, se transcribe el audio original.
        transcribe_from, audio_cleaned = audio, False
        if clean_audio:
            transcribe_from, audio_cleaned = await self._clean(audio, job_dir, progress, cancel)

        # 3. Modelo (se descarga solo la primera vez; se carga una vez por proceso)
        if not await asyncio.to_thread(self._models.is_cached, size):
            await progress.report("downloading_model", 0.0, f"Descargando el modelo Whisper ({size})")
            try:
                await asyncio.to_thread(
                    self._models.download,
                    size,
                    lambda done, total: progress.report_threadsafe(
                        "downloading_model", done / total if total else 0.0, f"Descargando el modelo Whisper ({size})"
                    ),
                )
            except Exception as error:  # noqa: BLE001 - red, Hub, permisos: todo es "no se pudo descargar"
                # ConnectionError y TimeoutError también son OSError: solo la falta de espacio conserva su código.
                if (isinstance(error, OSError) and error.errno == errno.ENOSPC) or isinstance(
                    error, InsufficientDiskSpaceError
                ):
                    raise
                log.error("descarga del modelo falló", exc_info=error)
                raise JobFailure("MODEL_DOWNLOAD_FAILED", "No se pudo descargar el modelo de transcripción.") from error
        self._check(cancel)
        model, device = await asyncio.to_thread(self._models.get, size)

        # 4. Transcripción (hilo: no bloquea el bucle, así el candado de BullMQ se renueva)
        await progress.report("transcribing", 0.0, f"Transcribiendo con {device}")
        result = await asyncio.to_thread(
            _transcribe_sync,
            model,
            transcribe_from,
            source_language,
            device,
            lambda fraction: progress.report_threadsafe(
                "transcribing", fraction, f"Transcribiendo ({fraction * 100:.0f}%)"
            ),
            cancel,
        )
        segments = result.segments

        # 4b. Quién habla (opcional): Whisper ya terminó, así que se suelta antes de lanzar pyannote.
        diarized = False
        if diarize:
            segments, diarized = await self._diarize(transcribe_from, segments, progress, cancel)

        # 5. Traducción opcional
        if translate_to and translate_to != (source_language or result.language):
            await progress.report("translating", 0.0, f"Traduciendo a {translate_to}")
            segments = await asyncio.to_thread(translate_segments, segments, source_language or result.language, translate_to)
        self._check(cancel)

        # 6. Artefactos
        await progress.report("uploading", 0.0, "Subiendo resultados")
        peaks, duration = await asyncio.to_thread(compute_waveform_peaks, video)
        files = {
            "output.srt": (segments_to_srt(segments), "application/x-subrip"),
            "segments.json": (json.dumps(segments_to_dicts(segments)), "application/json"),
            "waveform.json": (json.dumps({"peaks": peaks, "duration": duration}), "application/json"),
        }
        etags: dict[str, str] = {}
        for index, (name, (content, content_type)) in enumerate(files.items()):
            path = job_dir / name
            path.write_text(content, encoding="utf-8")
            etags[name] = await asyncio.to_thread(self._storage.upload_file, path, f"{prefix}{name}", content_type)
            await progress.report("uploading", (index + 1) / len(files), "Subiendo resultados")

        return TranscribeResult.model_validate(
            {
                "schemaVersion": 1,
                "jobId": job_id,
                "detectedLanguage": result.language,
                "device": result.device,
                "audioCleaned": audio_cleaned,
                "diarized": diarized,
                "durationSeconds": result.duration,
                "segmentCount": len(segments),
                "artifacts": {
                    "srt": f"{prefix}output.srt",
                    "segments": {
                        "bucket": self._storage.bucket,
                        "objectKey": f"{prefix}segments.json",
                        "etag": etags["segments.json"],
                    },
                    "waveform": f"{prefix}waveform.json",
                },
            }
        ).model_dump(mode="json")
