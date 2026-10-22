"""Benchmark de la limpieza de audio (cleanAudio): ¿baja el error de transcripción y cuánto cuesta?

Mezcla una locución de referencia (con su texto conocido, así el WER es exacto) con música y ruido SINTÉTICOS a
varias relaciones señal/ruido, transcribe con Whisper el audio original y el limpiado por el hijo REAL
(`python -m ai_worker.separate_cli`) y compara WER y tiempos.

Límites que hay que decir en voz alta: la música es sintética (acordes con armónicos y percusión) y la voz puede ser de
un sintetizador (más limpia que una persona real), así que el resultado es INDICATIVO. Para una decisión de producto hay
que repetirlo con grabaciones reales ruidosas (--speech y --reference aceptan las suyas).

Uso (necesita torch, demucs, faster-whisper, numpy y ffmpeg en el PATH):
    PYTHONPATH=apps/ai-worker/src[:otra/ruta/con/demucs] python apps/ai-worker/scripts/benchmark_separation.py \\
        --speech voz.wav --reference texto.txt --out resultados.md
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np


def read_wav(path: Path) -> tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as handle:
        rate, channels, width = handle.getframerate(), handle.getnchannels(), handle.getsampwidth()
        if width != 2:
            raise SystemExit("se espera un WAV PCM de 16 bits")
        data = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(np.float32) / 32768
    return rate, data.reshape(-1, channels).mean(axis=1)


def write_wav(path: Path, rate: int, samples: np.ndarray) -> None:
    clipped = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((clipped * 32767).astype("<i2").tobytes())


def synth_music(rate: int, seconds: float, rng: np.random.Generator) -> np.ndarray:
    """Acordes con armónicos, bajo y percusión (bombo y platillo de ruido): suena a música, ocupa el mismo espectro que la voz."""
    t = np.arange(int(rate * seconds)) / rate
    progression = [(220.0, 277.18, 329.63), (196.0, 246.94, 293.66), (174.61, 220.0, 261.63), (196.0, 246.94, 392.0)]
    out = np.zeros_like(t)
    beat = 0.5
    for index, start in enumerate(np.arange(0, seconds, 2.0)):
        chord = progression[index % len(progression)]
        mask = (t >= start) & (t < start + 2.0)
        local = t[mask] - start
        envelope = np.minimum(1.0, local * 8) * np.exp(-local * 0.6)
        for freq in chord:
            for harmonic, gain in ((1, 1.0), (2, 0.5), (3, 0.33), (4, 0.2)):
                out[mask] += gain * np.sin(2 * np.pi * freq * harmonic * local + rng.uniform(0, 6.28)) * envelope
        out[mask] += 0.8 * np.sin(2 * np.pi * (chord[0] / 2) * local) * envelope  # bajo
    for hit in np.arange(0, seconds, beat):
        i = int(hit * rate)
        n = min(int(0.12 * rate), len(t) - i)
        if n <= 0:
            continue
        local = np.arange(n) / rate
        out[i : i + n] += 1.2 * np.sin(2 * np.pi * (140 * np.exp(-local * 30)) * local) * np.exp(-local * 25)  # bombo
        if int(hit / beat) % 2 == 1:
            out[i : i + n] += 0.4 * rng.standard_normal(n) * np.exp(-local * 40)  # caja/platillo
    return out / (np.abs(out).max() + 1e-9)


def synth_noise(rate: int, seconds: float, rng: np.random.Generator) -> np.ndarray:
    """Ruido rosa (1/f), como un ventilador o una calle."""
    n = int(rate * seconds)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / rate)
    freqs[0] = 1.0
    pink = np.fft.irfft(spectrum / np.sqrt(freqs), n)
    return pink / (np.abs(pink).max() + 1e-9)


def mix_at(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    noise = noise[: len(speech)]
    power_s, power_n = float(np.mean(speech**2)), float(np.mean(noise**2))
    scale = np.sqrt(power_s / (power_n * 10 ** (snr_db / 10)))
    mixed = speech + noise * scale
    return mixed / max(1.0, float(np.abs(mixed).max()) / 0.95)


def to_16k_mono(source: Path, target: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", str(target)], check=True)


def words(text: str) -> list[str]:
    return re.sub(r"[^a-záéíóúñüçàèìòùâêîôûäöß0-9' ]+", " ", text.lower()).split()


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = words(reference), words(hypothesis)
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i]
        for j, h in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h)))
        previous = current
    return previous[-1] / max(1, len(ref))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--speech", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="en")
    parser.add_argument("--snrs", default="0,5,10")
    parser.add_argument("--kinds", default="music,noise")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    reference = args.reference.read_text(encoding="utf-8")
    rate, speech = read_wav(args.speech)
    rng = np.random.default_rng(args.seed)
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    def transcribe(path: Path) -> tuple[str, float]:
        started = time.perf_counter()
        segments, _ = model.transcribe(str(path), language=args.language, vad_filter=True, word_timestamps=True)
        text = " ".join(s.text for s in segments)
        return text, time.perf_counter() - started

    rows: list[tuple[str, float, float, float, float, float]] = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        clean16 = work / "clean16.wav"
        to_16k_mono(args.speech, clean16)
        base_text, base_time = transcribe(clean16)
        floor = wer(reference, base_text)
        print(f"voz sola: WER {floor:.3f} ({base_time:.1f} s)", flush=True)
        duration = len(speech) / rate
        for kind in args.kinds.split(","):
            noise = (synth_music if kind == "music" else synth_noise)(rate, duration + 1, rng)
            for snr in (float(x) for x in args.snrs.split(",")):
                raw = work / f"{kind}{snr:g}.wav"
                write_wav(raw, rate, mix_at(speech, noise, snr))
                mix16 = work / f"{kind}{snr:g}-16k.wav"
                to_16k_mono(raw, mix16)
                text_dirty, t_dirty = transcribe(mix16)
                cleaned = work / f"{kind}{snr:g}-vocals.wav"
                started = time.perf_counter()
                done = subprocess.run([sys.executable, "-m", "ai_worker.separate_cli", str(mix16), str(cleaned)], capture_output=True, text=True, env=os.environ)
                t_sep = time.perf_counter() - started
                if done.returncode != 0 or not cleaned.exists():
                    print(f"{kind} {snr:g} dB: la separación falló\n{done.stderr[-800:]}", flush=True)
                    continue
                text_clean, t_clean = transcribe(cleaned)
                row = (f"{kind} {snr:g} dB", wer(reference, text_dirty), wer(reference, text_clean), t_sep, t_dirty, t_clean)
                rows.append(row)
                print(row, flush=True)

    lines = [
        f"Locución de {duration:.0f} s, modelo Whisper `{args.model}` (CPU, int8), idioma `{args.language}`. WER de la voz sola: {floor:.3f}.",
        "",
        "| Mezcla | WER sin limpiar | WER limpiando | Mejora | Separación (s) | Whisper original (s) | Whisper limpio (s) |",
        "|---|---|---|---|---|---|---|",
    ]
    for label, dirty, clean, t_sep, t_dirty, t_clean in rows:
        lines.append(f"| {label} | {dirty:.3f} | {clean:.3f} | {dirty - clean:+.3f} | {t_sep:.1f} | {t_dirty:.1f} | {t_clean:.1f} |")
    lines += ["", f"Factor de tiempo de la separación en CPU: {sum(r[3] for r in rows) / max(1, len(rows)) / duration:.2f}x la duración del audio."]
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
