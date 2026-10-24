"""Doblaje (ADR 0020 §8): sintetiza la voz de cada segmento con el proveedor, la ajusta a su tiempo y arma `dub.mp3`.

Cada frase se pide por separado, se decodifica a WAV, se mide su duración real y se acelera o frena con `atempo` entre 0.85x y 1.25x
para que quepa en su hueco. Si aun así no cabe, se recorta el silencio de sus extremos; si todavía desborda, se informa en
`overflowSegments` y la frase siguiente espera a que termine (nunca se pisan dos voces: el desborde se absorbe en el silencio que
haya después, y la frase posterior a un hueco recupera su tiempo). Los segmentos en blanco no se envían: no hay nada que decir y se paga por carácter.
"""

from __future__ import annotations

import asyncio
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from captionforge.pipeline import _run_ffmpeg
from captionforge_contracts import DubJob, DubResult

from .adapters import Adapters
from .audio import MAX_TEMPO, RATE, has_audio_stream, join_wavs, plan_tempo, wav_duration, write_silence
from .config import WorkerConfig
from .errors import JobCancelled, JobFailure
from .progress import Progress
from .storage import EtagMismatch, Storage
from .translate import check_caps, read_segments

AUDIO_NAME = "dub.mp3"
VIDEO_NAME = "dubbed.mp4"
#: Tope de caracteres que aceptan los proveedores por petición (OpenAI 4096, ElevenLabs 5000): un segmento más largo no es un subtítulo.
MAX_SEGMENT_CHARACTERS = 4000
#: Un desborde menor que esto no se considera desborde (el MP3 añade unos milisegundos de relleno).
_FIT_TOLERANCE = 0.05
_MIN_SLOT = 0.1
_TRIM_SILENCE = (
    "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB,areverse,"
    "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB,areverse"
)


@dataclass(frozen=True)
class Piece:
    index: int
    start: float
    wav: Path
    duration: float
    overflow: bool


class DubRunner:
    def __init__(self, config: WorkerConfig, storage: Storage, adapters: Adapters) -> None:
        self._config = config
        self._storage = storage
        self._adapters = adapters

    async def run(self, payload: DubJob, progress: Progress, cancel: threading.Event) -> dict[str, Any]:
        job_dir = self._config.work_dir / str(payload.jobId)
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            return await self._run(payload, progress, cancel, job_dir)
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)

    @staticmethod
    def _check(cancel: threading.Event) -> None:
        if cancel.is_set():
            raise JobCancelled()

    async def _ffmpeg(self, *args: str) -> None:
        await _run_ffmpeg(
            ["ffmpeg", "-y", "-v", "error", *args],
            stall_timeout=self._config.ffmpeg_stall_timeout,
            total_timeout=self._config.ffmpeg_total_timeout,
        )

    async def _decode(self, source: Path, target: Path, *filters: str) -> float:
        """MP3 del proveedor -> WAV mono 24 kHz (con filtros opcionales). Devuelve la duración exacta."""
        chain = ",".join(filters)
        await self._ffmpeg("-i", str(source), "-ac", "1", "-ar", str(RATE), *(["-af", chain] if chain else []), "-c:a", "pcm_s16le", str(target))
        return wav_duration(target)

    async def _fit(self, raw: Path, job_dir: Path, index: int, slot: float) -> tuple[Path, float, bool]:
        """(WAV ajustado, duración, ¿desborda?). Ritmo acotado primero; si no basta, se recorta el silencio de los extremos."""
        plain = job_dir / f"v{index:04d}.wav"
        duration = await self._decode(raw, plain)
        tempo = plan_tempo(duration, slot)
        if tempo == 1.0 and duration <= slot + _FIT_TOLERANCE:
            return plain, duration, False
        fitted = job_dir / f"v{index:04d}.fit.wav"
        duration = await self._decode(raw, fitted, f"atempo={tempo:.4f}")
        if duration <= slot + _FIT_TOLERANCE or tempo < MAX_TEMPO:
            return fitted, duration, False
        trimmed = job_dir / f"v{index:04d}.trim.wav"
        duration = await self._decode(raw, trimmed, _TRIM_SILENCE, f"atempo={MAX_TEMPO:.4f}")
        return trimmed, duration, duration > slot + _FIT_TOLERANCE

    async def _mix(self, video: Path, voice: Path, output: Path, *, duck: bool) -> None:
        """Pone la voz en el video sin recodificar la imagen. `duck` baja el audio original solo mientras la voz habla (compresión
        con cadena lateral); si el video no trae audio, no hay nada que bajar y queda solo la voz."""
        if duck and await has_audio_stream(video):
            graph = (
                "[1:a]asplit=2[sc][fg];"
                "[0:a][sc]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=350[bg];"
                "[bg][fg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]"
            )
            audio_map = ["-filter_complex", graph, "-map", "0:v:0", "-map", "[a]"]
        else:
            audio_map = ["-map", "0:v:0", "-map", "1:a:0"]
        await self._ffmpeg("-i", str(video), "-i", str(voice), *audio_map, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(output))

    async def _run(self, payload: DubJob, progress: Progress, cancel: threading.Event, job_dir: Path) -> dict[str, Any]:
        job_id = str(payload.jobId)
        provider = str(payload.options.provider.value)
        mix = str(payload.options.mix.value)
        voice_id = payload.options.voice

        await progress.report("downloading_input", 0.0, "Leyendo los subtítulos")
        ref = payload.segments
        try:
            raw_segments = await asyncio.to_thread(self._storage.read_if_match, ref.bucket, ref.objectKey, ref.etag)
        except EtagMismatch as error:
            raise JobFailure("SEGMENTS_CHANGED", "Los subtítulos cambiaron después de pedir el doblaje. Vuelve a pedirlo.") from error
        segments = read_segments(raw_segments, job_id)
        characters = check_caps(self._config, segments)
        if any(len(segment.text.strip()) > MAX_SEGMENT_CHARACTERS for segment in segments):
            raise JobFailure("JOB_TOO_LARGE", f"Un segmento supera los {MAX_SEGMENT_CHARACTERS} caracteres: es demasiado largo para sintetizarlo.")
        self._check(cancel)

        # El video se descarga ANTES de sintetizar: si ya no existe, se descubre sin haber gastado nada en el proveedor.
        video: Path | None = None
        if mix != "none":
            await progress.report("downloading_input", 0.5, "Descargando el video")
            video = job_dir / "input.bin"
            await asyncio.to_thread(self._storage.download, payload.input.bucket, payload.input.objectKey, video)
            self._check(cancel)

        pending = [index for index, segment in enumerate(segments) if segment.text.strip()]
        pieces: list[Piece] = []
        async with self._adapters.voice(provider, job_id) as voice:
            for position, index in enumerate(pending):
                segment = segments[index]
                await progress.report("synthesizing", position / max(len(pending), 1), f"Generando la voz ({position}/{len(pending)})")
                audio = await voice.synthesize(segment.text.strip(), voice_id)
                self._check(cancel)
                raw = job_dir / f"r{index:04d}.mp3"
                raw.write_bytes(audio)
                wav, duration, overflow = await self._fit(raw, job_dir, index, max(segment.end - segment.start, _MIN_SLOT))
                pieces.append(Piece(index, segment.start, wav, duration, overflow))
                raw.unlink(missing_ok=True)
                self._check(cancel)

        # Pista completa: cada frase en su tiempo, sin solaparse (el desborde de una espera a la siguiente).
        await progress.report("mixing", 0.0, "Armando la pista de voz")
        parts: list[Path] = []
        cursor = 0.0
        for number, piece in enumerate(pieces):
            gap = piece.start - cursor
            if gap > 1 / RATE:
                silence = job_dir / f"g{number:04d}.wav"
                write_silence(silence, gap)
                parts.append(silence)
                cursor += gap
            parts.append(piece.wav)
            cursor += piece.duration
        track = job_dir / "track.wav"
        join_wavs(parts, track)
        audio_path = job_dir / AUDIO_NAME
        await self._ffmpeg("-i", str(track), "-c:a", "libmp3lame", "-b:a", "96k", "-ar", str(RATE), str(audio_path))
        self._check(cancel)

        artifacts = {"audio": f"{payload.outputPrefix}{AUDIO_NAME}"}
        dubbed: Path | None = None
        if video is not None:
            await progress.report("mixing", 0.5, "Mezclando la voz con el video")
            dubbed = job_dir / VIDEO_NAME
            await self._mix(video, audio_path, dubbed, duck=mix == "duck")
            artifacts["video"] = f"{payload.outputPrefix}{VIDEO_NAME}"
            self._check(cancel)

        await progress.report("uploading", 0.0, "Subiendo el resultado")
        await asyncio.to_thread(self._storage.upload_file, audio_path, artifacts["audio"], "audio/mpeg")
        if dubbed is not None:
            await asyncio.to_thread(self._storage.upload_file, dubbed, artifacts["video"], "video/mp4")

        return DubResult.model_validate(
            {
                "schemaVersion": 1,
                "jobId": job_id,
                "provider": provider,
                "mix": mix,
                "segmentCount": len(segments),
                "characters": characters,
                "overflowSegments": [piece.index for piece in pieces if piece.overflow],
                "artifacts": artifacts,
            }
        ).model_dump(mode="json", exclude_none=True)
