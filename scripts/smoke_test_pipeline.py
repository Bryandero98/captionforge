#!/usr/bin/env python
"""Fase 0 smoke test: proves transcripcion + traduccion + subtitulos
funcionan de verdad, sin FastAPI ni frontend de por medio.

Uso:
    python scripts/smoke_test_pipeline.py video.mp4
    python scripts/smoke_test_pipeline.py video.mp4 --hardsub
    python scripts/smoke_test_pipeline.py video.mp4 --language es --translate en --hardsub
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

# Windows' default console codepage isn't UTF-8, so accented transcript text
# (á, í, ñ...) prints as mojibake otherwise - verified live: the .srt file
# itself was always correct UTF-8, only the console echo was garbled.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from captionforge.ffmpeg_utils import build_burn_subtitles_cmd, build_extract_audio_cmd
from captionforge.srt import Segment, WordTiming, segments_to_srt
from captionforge.translate import translate_segments


def select_device(model_size: str):
    """Tries GPU (cuda/float16) first, falls back cleanly to CPU (int8). Returns (model, device_used)."""
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        return model, "cuda"
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any CUDA/cuDNN init failure should fall back to CPU, not crash
        print(f"GPU no disponible ({exc}); usando CPU.")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        return model, "cpu"


def extract_audio(video_path: Path, audio_path: Path) -> None:
    cmd = build_extract_audio_cmd(str(video_path), str(audio_path))
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def transcribe(model, audio_path: Path, language: str | None) -> list[Segment]:
    raw_segments, info = model.transcribe(
        str(audio_path),
        language=language,
        vad_filter=True,
        word_timestamps=True,
    )
    print(f"Idioma detectado: {info.language} (probabilidad {info.language_probability:.2f})")

    segments: list[Segment] = []
    for raw in raw_segments:
        # word_timestamps=True makes faster-whisper return these as
        # numpy.float64 instead of plain float - verified live. Cast
        # explicitly so Segment stays plain-Python-float, matching its own
        # declared type.
        start, end = float(raw.start), float(raw.end)
        progress_pct = (end / info.duration * 100) if info.duration else 0.0
        print(f"[{progress_pct:5.1f}%] {start:7.2f}s -> {end:7.2f}s  {raw.text.strip()}")

        words = None
        if raw.words:
            words = [WordTiming(start=float(w.start), end=float(w.end), text=w.word) for w in raw.words]

        segments.append(Segment(start=start, end=end, text=raw.text, words=words))

    return segments


def burn_subtitles(video_path: Path, srt_path: Path, output_path: Path) -> None:
    cmd = build_burn_subtitles_cmd(str(video_path), str(srt_path), str(output_path))
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path, help="ruta al video de entrada")
    parser.add_argument(
        "--model", default="small", choices=["base", "small", "medium"], help="tamano del modelo Whisper"
    )
    parser.add_argument(
        "--language",
        default=None,
        help="idioma de origen forzado (p. ej. es, en) - si se omite, se auto-detecta",
    )
    parser.add_argument(
        "--translate",
        default=None,
        metavar="CODE",
        help="traduce los subtitulos a este idioma (p. ej. es, en)",
    )
    parser.add_argument(
        "--hardsub", action="store_true", help="ademas del .srt, quema los subtitulos en el video"
    )
    args = parser.parse_args()

    if not args.video.exists():
        sys.exit(f"cliguard: no existe el archivo de video: {args.video}")

    srt_path = args.video.with_suffix(".srt")
    captioned_path = args.video.with_name(f"{args.video.stem}_captioned.mp4")

    with tempfile.TemporaryDirectory() as tmp_dir:
        audio_path = Path(tmp_dir) / "audio.wav"

        print("== Extrayendo audio ==")
        extract_audio(args.video, audio_path)

        print("\n== Cargando modelo Whisper ==")
        model, device = select_device(args.model)
        print(f"Modelo '{args.model}' cargado en: {device}")

        print("\n== Transcribiendo ==")
        segments = transcribe(model, audio_path, args.language)

        # audio_path se borra automaticamente al salir del bloque
        # `with tempfile.TemporaryDirectory()` - limpieza garantizada incluso
        # si algo de lo anterior falla.

    if args.translate:
        source_language = args.language or "en"
        print(f"\n== Traduciendo {source_language}->{args.translate} ==")
        segments = translate_segments(segments, source_language, args.translate)

    print(f"\n== Escribiendo {srt_path} ==")
    srt_path.write_text(segments_to_srt(segments), encoding="utf-8")
    print(srt_path.read_text(encoding="utf-8"))

    if args.hardsub:
        print(f"\n== Quemando subtitulos en {captioned_path} ==")
        burn_subtitles(args.video, srt_path, captioned_path)
        print(f"Listo: {captioned_path}")

    print("\n== OK ==")


if __name__ == "__main__":
    main()
