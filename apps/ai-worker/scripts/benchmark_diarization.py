"""Benchmark de identificar quién habla (diarize): ¿asigna bien a cada voz y cuánto cuesta?

Toma un diálogo con voces que se alternan y VERDAD CONOCIDA (un JSON con inicio, fin y hablante de cada intervención),
lo transcribe con Whisper, lo pasa por el hijo REAL (`python -m ai_worker.diarize_cli`, pyannote 3.1) y mide:

- exactitud de la asignación palabra a palabra (cada palabra de Whisper contra el hablante verdadero en ese instante),
  con la correspondencia de etiquetas que más aciertos da (las etiquetas del modelo no tienen nombre);
- cuántos hablantes se detectaron frente a los reales;
- tiempo de la identificación y su relación con la duración del audio (factor de tiempo real, en CPU).

Límites que hay que decir en voz alta: las voces pueden ser sintéticas (más limpias y regulares que personas reales,
sin solapamiento ni ruido), son pocas, y las pausas entre intervenciones son claras; el resultado es INDICATIVO. Para
prometer un número hay que repetirlo con grabaciones reales (--audio y --truth aceptan las suyas).

Uso (necesita torch, pyannote.audio, faster-whisper, numpy y ffmpeg en el PATH; el token de Hugging Face por HF_TOKEN o
HF_TOKEN_FILE):
    PYTHONPATH=apps/ai-worker/src[:otra/ruta/con/pyannote] python apps/ai-worker/scripts/benchmark_diarization.py \\
        --audio dialogo.wav --truth verdad.json --out resultados.md
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from ai_worker.diarization import SubprocessDiarizer, Turn, assign_speakers, resolve_hf_token
from captionforge.srt import Segment, WordTiming


def to_mono_16k(source: Path, target: Path) -> float:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)], check=True)
    import wave

    with wave.open(str(target), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def transcribe(audio: Path, size: str) -> list[Segment]:
    from faster_whisper import WhisperModel

    model = WhisperModel(size, device="cpu", compute_type="int8")
    raw, _ = model.transcribe(str(audio), vad_filter=True, word_timestamps=True)
    segments = []
    for item in raw:
        words = [WordTiming(float(w.start), float(w.end), w.word, float(w.probability)) for w in (item.words or [])]
        segments.append(Segment(float(item.start), float(item.end), item.text, words or None))
    return segments


def truth_at(truth: list[dict], moment: float) -> str | None:
    for entry in truth:
        if entry["start"] - 0.15 <= moment <= entry["end"] + 0.15:
            return str(entry["speaker"])
    return None


def word_accuracy(segments: list[Segment], truth: list[dict]) -> tuple[int, int, dict[str, str]]:
    """(palabras acertadas, palabras evaluadas, correspondencia usada) con la mejor correspondencia de etiquetas."""
    pairs = []
    for segment in segments:
        for word in segment.words or []:
            real = truth_at(truth, (word.start + word.end) / 2)
            if real is not None and segment.speaker is not None:
                pairs.append((real, segment.speaker))
    reals = sorted({real for real, _ in pairs})
    labels = sorted({label for _, label in pairs})
    best: tuple[int, dict[str, str]] = (0, {})
    for chosen in itertools.permutations(labels, min(len(reals), len(labels))):
        mapping = dict(zip(chosen, reals, strict=False))
        hits = sum(1 for real, label in pairs if mapping.get(label) == real)
        if hits > best[0]:
            best = (hits, mapping)
    return best[0], len(pairs), best[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--truth", type=Path, required=True, help="JSON: lista de {start, end, speaker}")
    parser.add_argument("--model", default="base", help="modelo de Whisper")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    token = resolve_hf_token()
    if token is None:
        raise SystemExit("falta el token de Hugging Face (HF_TOKEN o HF_TOKEN_FILE)")
    truth = json.loads(args.truth.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory() as work:
        audio = Path(work) / "audio.wav"
        duration = to_mono_16k(args.audio, audio)
        print(f"audio: {duration:.1f} s", file=sys.stderr)

        started = time.perf_counter()
        segments = transcribe(audio, args.model)
        whisper_seconds = time.perf_counter() - started

        async def report(stage: str, fraction: float) -> None:
            print(f"  {stage} {fraction:.0%}", file=sys.stderr)

        started = time.perf_counter()
        turns: list[Turn] = asyncio.run(SubprocessDiarizer(token=token).diarize(audio, report))
        diarize_seconds = time.perf_counter() - started

    assigned = assign_speakers(segments, turns)
    hits, total, mapping = word_accuracy(assigned, truth)
    real_speakers = len({entry["speaker"] for entry in truth})
    found_speakers = len({turn.speaker for turn in turns})

    lines = [
        "# Benchmark de identificar quién habla",
        "",
        f"- Audio: `{args.audio.name}`, {duration:.1f} s, {len(truth)} intervenciones, {real_speakers} voces reales.",
        f"- Whisper `{args.model}` (CPU, int8): {whisper_seconds:.1f} s, {len(segments)} segmentos.",
        f"- Identificación (pyannote 3.1, CPU): {diarize_seconds:.1f} s = {diarize_seconds / duration:.2f}x la duración del audio.",
        f"- Hablantes detectados: {found_speakers} (reales: {real_speakers}).",
        f"- Segmentos tras asignar: {len(assigned)} (antes: {len(segments)}; la diferencia son segmentos partidos por cambio de voz).",
        f"- Exactitud palabra a palabra: {hits}/{total} = {hits / total:.1%}" if total else "- Exactitud: sin palabras evaluables.",
        f"- Correspondencia de etiquetas usada: {mapping}",
        "",
    ]
    args.out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
