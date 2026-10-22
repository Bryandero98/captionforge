"""Identificar quién habla (pyannote) después de transcribir, en un SUBPROCESO (ADR 0014).

Orden con la opción activa: Whisper transcribe -> se suelta Whisper (VRAM) -> el hijo `diarize_cli` etiqueta los
turnos de voz -> `assign_speakers` pone el hablante a cada segmento, partiéndolo por palabras donde cambia la voz. `torch`
y `pyannote` solo se importan en el hijo: el worker no depende de ellos (extra opcional, requirements-diarization.txt).

El token de Hugging Face solo existe en el entorno del worker. Al hijo llega por la variable de entorno HF_TOKEN, nunca
por argumentos (se verían en la lista de procesos) y nunca se escribe en un log ni en un mensaje.

Si la identificación falla, quien llama continúa con la transcripción normal (respaldo); aquí solo se informa del fallo.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from captionforge.srt import Segment

from .child import ChildFailed, Report, run_child

# Etapas que el hijo puede anunciar (las mismas del contrato).
DIARIZATION_STAGES = frozenset({"downloading_diarization_model", "diarizing"})


class DiarizationFailed(Exception):
    """La identificación no se pudo completar. El mensaje es seguro para mostrarlo: sin rutas, trazas ni token."""


class DiarizationUnavailable(DiarizationFailed):
    """Falta el token de Hugging Face (o el componente): no se intenta y la transcripción sigue normal."""


@dataclass(frozen=True)
class Turn:
    """Un tramo [start, end) en que habla `speaker` (etiqueta del modelo, p. ej. SPEAKER_00)."""

    start: float
    end: float
    speaker: str


class Diarizer(Protocol):
    async def diarize(self, audio: Path, report: Report) -> list[Turn]:
        """Devuelve los turnos de voz de `audio`. `report(etapa, fracción)` informa del avance."""
        ...


# ---------- token ----------

_TOKEN = re.compile(r"hf_[A-Za-z0-9_\-]+")
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?HF_TOKEN\s*=\s*(.*?)\s*$")


def resolve_hf_token(env: Mapping[str, str] | None = None) -> str | None:
    """HF_TOKEN del entorno, o el contenido del archivo que indique HF_TOKEN_FILE (el token solo, o una línea
    `HF_TOKEN=...` de un .env). None si no hay nada utilizable. Nunca registra el valor."""
    env = os.environ if env is None else env
    direct = (env.get("HF_TOKEN") or "").strip()
    if direct:
        return direct
    path = (env.get("HF_TOKEN_FILE") or "").strip()
    if not path:
        return None
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except OSError:
        return None
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        match = _ENV_LINE.match(line)
        value = match.group(1).strip("'\"") if match else line.strip()
        if value and (match or _TOKEN.fullmatch(value)):
            return value
    return None


# ---------- subproceso ----------


def _parse_turns(raw: str) -> list[Turn]:
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("no es una lista")
        turns = []
        for item in data:
            start, end, speaker = float(item["start"]), float(item["end"]), item["speaker"]
            if not isinstance(speaker, str) or not speaker or not (math.isfinite(start) and math.isfinite(end)) or end < start or start < 0:
                raise ValueError("turno inválido")
            turns.append(Turn(start, end, speaker))
    except (ValueError, KeyError, TypeError) as error:
        raise DiarizationFailed("La identificación de hablantes devolvió un resultado inválido.") from error
    return turns


class SubprocessDiarizer:
    """Lanza `python -m ai_worker.diarize_cli <audio.wav> <turnos.json>` y lee su progreso por la salida estándar."""

    def __init__(
        self,
        token: str | None,
        command: list[str] | None = None,
        stall_timeout: float = 600.0,
        total_timeout: float = 7200.0,
    ) -> None:
        self._token = token
        self._command = command or [sys.executable, "-m", "ai_worker.diarize_cli"]
        self._stall = stall_timeout
        self._total = total_timeout

    def __repr__(self) -> str:  # el token no puede acabar en un log por un repr
        return f"SubprocessDiarizer(token={'***' if self._token else None})"

    async def diarize(self, audio: Path, report: Report) -> list[Turn]:
        if not self._token:
            raise DiarizationUnavailable("Falta el token de Hugging Face para identificar a los hablantes.")
        target = audio.with_name("turnos.json")
        try:
            await run_child(
                self._command,
                [str(audio), str(target)],
                stages=DIARIZATION_STAGES,
                report=report,
                stall_timeout=self._stall,
                total_timeout=self._total,
                output=target,
                label="la identificación de hablantes",
                env={**os.environ, "HF_TOKEN": self._token, "PYANNOTE_METRICS_ENABLED": "0"},
                redact=[self._token],
            )
        except ChildFailed as error:
            raise DiarizationFailed(str(error)) from error
        try:
            return _parse_turns(target.read_text(encoding="utf-8"))
        except OSError as error:
            raise DiarizationFailed("La identificación de hablantes no produjo resultado.") from error


# ---------- asignación de hablantes a los segmentos ----------


def _overlap(start: float, end: float, turn: Turn) -> float:
    return max(0.0, min(end, turn.end) - max(start, turn.start))


def _speaker_for(start: float, end: float, turns: list[Turn]) -> str:
    """La etiqueta del turno que más cubre [start, end]; en un hueco, la del turno más cercano."""
    best, covered = None, 0.0
    for turn in turns:
        overlap = _overlap(start, end, turn)
        if overlap > covered:
            best, covered = turn, overlap
    if best is None:
        middle = (start + end) / 2
        best = min(turns, key=lambda t: 0.0 if t.start <= middle <= t.end else min(abs(middle - t.start), abs(middle - t.end)))
    return best.speaker


def assign_speakers(segments: list[Segment], turns: list[Turn]) -> list[Segment]:
    """Pone el hablante a cada segmento. Si un segmento con tiempos por palabra cruza un cambio de voz, se PARTE en ese
    punto (cada trozo conserva sus palabras y sus tiempos); sin tiempos por palabra solo puede asignarse el hablante
    con más solapamiento (aproximado, no se parte). Las etiquetas del modelo se renombran SPEAKER_01, SPEAKER_02… por
    orden de aparición en la transcripción, que es lo que ve la persona usuaria. Sin turnos no cambia nada."""
    if not turns:
        return segments
    labelled: list[Segment] = []
    for segment in segments:
        if segment.words:
            runs: list[tuple[str, list]] = []
            for word in segment.words:
                speaker = _speaker_for(word.start, word.end, turns)
                if runs and runs[-1][0] == speaker:
                    runs[-1][1].append(word)
                else:
                    runs.append((speaker, [word]))
            if len(runs) > 1:
                for speaker, words in runs:
                    text = "".join(w.text for w in words)
                    labelled.append(replace(segment, start=words[0].start, end=words[-1].end, text=text, words=words, speaker=speaker))
                continue
        labelled.append(replace(segment, speaker=_speaker_for(segment.start, segment.end, turns)))

    names: dict[str, str] = {}
    for segment in labelled:
        assert segment.speaker is not None
        names.setdefault(segment.speaker, f"SPEAKER_{len(names) + 1:02d}")
    return [replace(segment, speaker=names[segment.speaker]) for segment in labelled]  # type: ignore[index]
