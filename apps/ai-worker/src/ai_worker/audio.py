"""Ayudantes de audio del doblaje (ADR 0020 §8).

La pista doblada se arma en Python con WAV de un único formato (mono, 16 bits, 24 kHz): cada frase sintetizada se decodifica a ese
formato con ffmpeg, se mide su duración EXACTA con el encabezado WAV (sin ffprobe), se acelera lo justo y se pega después del silencio
que la separa de la anterior. Así no hay un filtro de ffmpeg con mil entradas (el límite de la línea de comandos de Windows) y la
duración de cada trozo es un dato, no una estimación.
"""

from __future__ import annotations

import asyncio
import wave
from collections.abc import Sequence
from pathlib import Path

from captionforge.ffmpeg_locator import ffmpeg_env, with_ffmpeg_path

RATE = 24_000
SAMPLE_WIDTH = 2
#: Ajuste de ritmo permitido por frase (ADR 0020 §8): más allá, la voz suena a caricatura o a cámara lenta.
MIN_TEMPO = 0.85
MAX_TEMPO = 1.25
#: Por debajo de esta diferencia relativa no se reprocesa el audio: no se oye y cada pasada cuesta una llamada a ffmpeg.
_TEMPO_TOLERANCE = 0.03
_CHUNK_FRAMES = 1 << 16


def plan_tempo(duration: float, slot: float) -> float:
    """Factor de `atempo` para que una voz de `duration` segundos quepa en `slot` (siempre entre MIN_TEMPO y MAX_TEMPO)."""
    if slot <= 0:
        return MAX_TEMPO
    ratio = duration / slot
    if abs(ratio - 1.0) <= _TEMPO_TOLERANCE:
        return 1.0
    return min(max(ratio, MIN_TEMPO), MAX_TEMPO)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def write_silence(path: Path, seconds: float) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(SAMPLE_WIDTH)
        wav.setframerate(RATE)
        remaining = round(max(seconds, 0.0) * RATE)
        block = b"\0" * (SAMPLE_WIDTH * min(remaining, _CHUNK_FRAMES))
        while remaining > 0:
            frames = min(remaining, _CHUNK_FRAMES)
            wav.writeframes(block[: frames * SAMPLE_WIDTH])
            remaining -= frames


def join_wavs(parts: Sequence[Path], out: Path) -> None:
    """Concatena WAV del formato común, en streaming (la pista de un video largo no cabe cómoda en memoria)."""
    with wave.open(str(out), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(SAMPLE_WIDTH)
        target.setframerate(RATE)
        for part in parts:
            with wave.open(str(part), "rb") as source:
                if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, SAMPLE_WIDTH, RATE):
                    raise ValueError("Todos los trozos deben ser mono, 16 bits y 24 kHz.")
                while chunk := source.readframes(_CHUNK_FRAMES):
                    target.writeframes(chunk)


async def _stream_lines(media: Path) -> list[str]:
    """Líneas `Stream #...` de `ffmpeg -i` (sin salida termina con error, pero lista los flujos)."""
    process = await asyncio.create_subprocess_exec(
        *with_ffmpeg_path(["ffmpeg", "-hide_banner", "-i", str(media)]),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=ffmpeg_env(),
    )
    _, stderr = await process.communicate()
    return [line for line in stderr.decode("utf-8", "replace").splitlines() if "Stream #" in line]


async def has_audio_stream(video: Path) -> bool:
    """¿Trae el archivo una pista de audio?"""
    return any(" Audio:" in line for line in await _stream_lines(video))


async def has_video_stream(media: Path) -> bool:
    """¿Trae el archivo imagen en movimiento? Un audio con carátula (MP3, M4A o FLAC con portada) no cuenta: la portada es un
    «video» de un solo fotograma marcado `attached pic`."""
    return any(" Video:" in line and "attached pic" not in line for line in await _stream_lines(media))
