"""Hijo de la identificación de hablantes: `python -m ai_worker.diarize_cli <audio.wav> <turnos.json>`.

Es el ÚNICO sitio que importa torch y pyannote. Protocolo con el worker: líneas `PROGRESS <etapa> <fracción>` por la
salida estándar; la traza de un error va a stderr y el código de salida es distinto de cero (ver child.py). El token de
Hugging Face llega por la variable de entorno HF_TOKEN, nunca por argumentos. Al terminar el proceso, la VRAM vuelve al
sistema.

Entrada: WAV PCM de 16 bits mono (lo que produce el ffmpeg del pipeline). El audio entra a pyannote YA decodificado, en
memoria (`{"waveform", "sample_rate"}`): así no pasa por torchcodec/ffmpeg compartido, que no hace falta instalar.
Salida: JSON `[{"start", "end", "speaker"}]` ordenado por inicio.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import wave
from collections.abc import Callable, Sequence
from pathlib import Path

from .diarization import Turn

MODEL_NAME = "pyannote/speaker-diarization-3.1"
# Peso de cada paso del pipeline en la barra de la etapa `diarizing` (el resto de pasos es instantáneo).
STEP_WEIGHTS = {"segmentation": (0.0, 0.35), "embeddings": (0.35, 0.95)}

Emit = Callable[[str, float], None]
Engine = Callable[[Path, Emit], list[Turn]]


def pyannote_engine(audio: Path, emit: Emit) -> list[Turn]:  # pragma: no cover - necesita torch y pyannote; se mide en el benchmark
    """Etiqueta quién habla con pyannote/speaker-diarization-3.1, en GPU si hay y en CPU si no."""
    import numpy as np
    import torch

    import pyannote.audio.pipelines.speaker_diarization as speaker_diarization

    # pyannote.audio 4.x carga SIEMPRE el PLDA del modelo «community-1» (otro repositorio con aceptación de condiciones
    # aparte), pero solo lo usa el agrupamiento VBx. El pipeline 3.1 agrupa de forma aglomerativa y no lo necesita: se
    # omite para que baste con aceptar las condiciones de 3.1 y de segmentation-3.0 (ADR 0014).
    speaker_diarization.get_plda = lambda *args, **kwargs: None
    from pyannote.audio import Pipeline

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("falta HF_TOKEN")
    emit("downloading_diarization_model", 0.0)
    pipeline = Pipeline.from_pretrained(MODEL_NAME, token=token)
    if pipeline is None:
        raise RuntimeError("no se pudo cargar el pipeline")
    emit("downloading_diarization_model", 1.0)
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))

    with wave.open(str(audio), "rb") as reader:
        if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
            raise ValueError("se espera un WAV PCM de 16 bits y un canal")
        rate = reader.getframerate()
        samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype=np.int16).astype("float32") / 32768
    waveform = torch.from_numpy(samples).unsqueeze(0)

    last = 0.0

    def hook(step_name: str, step_artifact=None, file=None, total=None, completed=None) -> None:  # noqa: ANN001
        nonlocal last
        weights = STEP_WEIGHTS.get(step_name)
        if weights is None:
            return
        inner = (completed / total) if total and completed is not None else 1.0
        last = max(last, weights[0] + (weights[1] - weights[0]) * min(max(inner, 0.0), 1.0))
        emit("diarizing", last)

    emit("diarizing", 0.0)
    result = pipeline({"waveform": waveform, "sample_rate": rate}, hook=hook)
    annotation = getattr(result, "speaker_diarization", result)  # 4.x devuelve un objeto con la anotación dentro
    turns = [Turn(float(t.start), float(t.end), str(label)) for t, _, label in annotation.itertracks(yield_label=True)]
    emit("diarizing", 1.0)
    return sorted(turns, key=lambda turn: (turn.start, turn.end))


def main(argv: Sequence[str], engine: Engine | None = None) -> int:
    if len(argv) != 2:
        print("uso: python -m ai_worker.diarize_cli <audio.wav> <turnos.json>", file=sys.stderr)
        return 2

    def emit(stage: str, fraction: float) -> None:
        print(f"PROGRESS {stage} {fraction:.3f}", flush=True)

    try:
        turns = (engine or pyannote_engine)(Path(argv[0]), emit)
        Path(argv[1]).write_text(
            json.dumps([{"start": t.start, "end": t.end, "speaker": t.speaker} for t in turns]), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001 - cualquier fallo (falta de pyannote, token, GPU, audio raro) es "no se pudo"; el worker transcribe sin hablantes
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
