"""Hijo de la separación de voz: `python -m ai_worker.separate_cli <entrada.wav> <salida.wav>`.

Es el ÚNICO sitio que importa torch y demucs. Protocolo con el worker: líneas `PROGRESS <etapa> <fracción>` por la
salida estándar; la traza de un error va a stderr y el código de salida es distinto de cero. Al terminar el proceso,
la VRAM vuelve al sistema (ver separation.py).

Entrada y salida son WAV PCM de 16 bits mono (lo que produce el ffmpeg del pipeline y lo que espera Whisper). El
audio se procesa en trozos de CHUNK_SECONDS para que la memoria no crezca con la duración del video.
"""

from __future__ import annotations

import struct
import sys
import traceback
import wave
from collections.abc import Callable, Sequence
from pathlib import Path

MODEL_NAME = "htdemucs"
CHUNK_SECONDS = 600

Emit = Callable[[str, float], None]
Engine = Callable[[Path, Path, Emit], None]


def read_wav_mono(path: Path) -> tuple[int, list[float]]:
    """(frecuencia, muestras en [-1, 1)) de un WAV PCM16 mono. Para pruebas y ficheros pequeños."""
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise ValueError("se espera un WAV PCM de 16 bits y un canal")
        frames = handle.readframes(handle.getnframes())
        rate = handle.getframerate()
    count = len(frames) // 2
    return rate, [value / 32768 for value in struct.unpack(f"<{count}h", frames)]


def write_wav_mono(path: Path, rate: int, samples: Sequence[float]) -> None:
    """Escribe muestras en [-1, 1] como PCM16; lo que se sale de rango se recorta, no se desborda."""
    clipped = [max(-32768, min(32767, round(value * 32768))) for value in samples]
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack(f"<{len(clipped)}h", *clipped))


def demucs_engine(source: Path, target: Path, emit: Emit) -> None:  # pragma: no cover - necesita torch y demucs; se mide en el benchmark
    """Aísla la voz con htdemucs (stem `vocals`), por trozos, en GPU si hay y en CPU si no (o si la GPU se queda sin memoria)."""
    import torch
    import torchaudio.functional as audio_functional
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    emit("downloading_separation_model", 0.0)
    model = get_model(MODEL_NAME)  # los pesos se descargan una vez y se comprueba su hash
    model.eval()
    emit("downloading_separation_model", 1.0)
    vocals = model.sources.index("vocals")

    def separate_all(device: str) -> None:
        model.to(device)
        with wave.open(str(source), "rb") as reader, wave.open(str(target), "wb") as writer:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
                raise ValueError("se espera un WAV PCM de 16 bits y un canal")
            rate, total = reader.getframerate(), reader.getnframes()
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(rate)
            step = CHUNK_SECONDS * rate
            done = 0
            while done < total:
                frames = reader.readframes(min(step, total - done))
                chunk = torch.frombuffer(bytearray(frames), dtype=torch.int16).float() / 32768
                mix = audio_functional.resample(chunk, rate, model.samplerate)[None].repeat(model.audio_channels, 1)
                mean, std = mix.mean(), mix.std() + 1e-8
                base = done / total

                def on_segment(info: dict, base: float = base, size: int = len(chunk)) -> None:
                    length = info.get("audio_length") or 1
                    inner = min(max(info.get("segment_offset", 0) / length, 0.0), 1.0)
                    emit("separating_voice", base + (size / total) * inner)

                with torch.no_grad():
                    stems = apply_model(model, ((mix - mean) / std)[None], device=device, split=True, overlap=0.25, shifts=0, progress=False, callback=on_segment)[0]
                voice = (stems[vocals] * std + mean).mean(dim=0)
                voice = audio_functional.resample(voice, model.samplerate, rate).clamp(-1.0, 1.0)
                writer.writeframes((voice * 32767).to(torch.int16).cpu().numpy().tobytes())
                done += len(chunk)
                emit("separating_voice", done / total)
                del mix, stems, voice, chunk

    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        separate_all(device)
    except torch.cuda.OutOfMemoryError:
        # Sin memoria en la GPU: se reintenta en CPU (más lento, pero el trabajo sigue limpio).
        torch.cuda.empty_cache()
        separate_all("cpu")


def main(argv: Sequence[str], engine: Engine | None = None) -> int:
    if len(argv) != 2:
        print("uso: python -m ai_worker.separate_cli <entrada.wav> <salida.wav>", file=sys.stderr)
        return 2

    def emit(stage: str, fraction: float) -> None:
        print(f"PROGRESS {stage} {fraction:.3f}", flush=True)

    try:
        (engine or demucs_engine)(Path(argv[0]), Path(argv[1]), emit)
    except Exception:  # noqa: BLE001 - cualquier fallo (falta de demucs, GPU, audio raro) es "no se pudo"; el worker usa el audio original
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
