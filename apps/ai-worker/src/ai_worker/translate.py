"""Traducción de segmentos (ADR 0020): lee segments.json, traduce el TEXTO por lotes y conserva los tiempos.

Los tiempos no se tocan: traducir no cambia cuándo se dijo cada frase. Los tiempos por palabra del idioma original no valen
en el traducido, así que se reparten por longitud (aproximación honesta, sin probabilidad). Los segmentos en blanco no se
envían: no hay nada que traducir y los proveedores cobran por carácter.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

from captionforge.srt import Segment, redistribute_word_timings, segments_from_dicts, segments_to_dicts
from captionforge_contracts import TranslateJob, TranslateResult

from .adapters import Adapters
from .config import WorkerConfig
from .errors import JobCancelled, JobFailure
from .progress import Progress
from .storage import EtagMismatch, Storage

log = logging.getLogger("ai_worker")

OUTPUT_NAME = "translated-segments.json"
#: Segmentos por petición al traductor: lotes pequeños limitan lo que se pierde si uno falla y dejan puntos de cancelación.
BATCH_SIZE = 40


def read_segments(raw: bytes, job_id: str) -> list[Segment]:
    try:
        return segments_from_dicts(json.loads(raw))
    except Exception as error:  # noqa: BLE001 - un archivo corrupto es un fallo interno, no del usuario
        log.error("segments.json ilegible en el trabajo %s", job_id, exc_info=error)
        raise JobFailure("INTERNAL", "Los subtítulos guardados no se pueden leer.") from error


def check_caps(config: WorkerConfig, segments: list[Segment]) -> int:
    """Tope de gasto (ADR 0020 §7): se comprueba ANTES de llamar al proveedor. Devuelve los caracteres a enviar."""
    characters = sum(len(segment.text.strip()) for segment in segments)
    if len(segments) > config.max_job_segments:
        raise JobFailure("JOB_TOO_LARGE", f"El trabajo tiene {len(segments)} segmentos; el máximo es {config.max_job_segments}.")
    if characters > config.max_job_characters:
        raise JobFailure("JOB_TOO_LARGE", f"El trabajo tiene {characters} caracteres; el máximo es {config.max_job_characters}.")
    return characters


class TranslateRunner:
    def __init__(self, config: WorkerConfig, storage: Storage, adapters: Adapters) -> None:
        self._config = config
        self._storage = storage
        self._adapters = adapters

    async def run(self, payload: TranslateJob, progress: Progress, cancel: threading.Event) -> dict[str, Any]:
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

    async def _run(self, payload: TranslateJob, progress: Progress, cancel: threading.Event, job_dir: Path) -> dict[str, Any]:
        job_id = str(payload.jobId)
        provider = str(payload.options.provider.value)
        source, target = payload.options.sourceLanguage, payload.options.targetLanguage

        await progress.report("downloading_input", 0.0, "Leyendo los subtítulos")
        ref = payload.segments
        try:
            raw = await asyncio.to_thread(self._storage.read_if_match, ref.bucket, ref.objectKey, ref.etag)
        except EtagMismatch as error:
            raise JobFailure("SEGMENTS_CHANGED", "Los subtítulos cambiaron después de pedir la traducción. Vuelve a pedirla.") from error
        segments = read_segments(raw, job_id)
        characters = check_caps(self._config, segments)
        self._check(cancel)

        # Solo se envía lo que tiene texto; cada traducción vuelve a su posición.
        pending = [index for index, segment in enumerate(segments) if segment.text.strip()]
        translated: dict[int, str] = {}
        async with self._adapters.translator(provider, job_id) as translator:
            for start in range(0, len(pending), BATCH_SIZE):
                batch = pending[start : start + BATCH_SIZE]
                await progress.report("translating", start / max(len(pending), 1), f"Traduciendo ({start}/{len(pending)})")
                texts = [segments[index].text.strip() for index in batch]
                result = await translator.translate(texts, source, target)
                if len(result) != len(texts):
                    raise JobFailure("EXTERNAL_UNAVAILABLE", "El proveedor devolvió una respuesta incompleta.")
                translated.update(zip(batch, result, strict=True))
                self._check(cancel)

        output: list[Segment] = []
        for index, segment in enumerate(segments):
            if index not in translated:
                output.append(segment)
                continue
            text = translated[index].strip()
            output.append(replace(segment, text=text, words=redistribute_word_timings(text, segment.start, segment.end)))

        await progress.report("uploading", 0.0, "Guardando la traducción")
        path = job_dir / OUTPUT_NAME
        path.write_text(json.dumps(segments_to_dicts(output)), encoding="utf-8")
        key = f"{payload.outputPrefix}{OUTPUT_NAME}"
        etag = await asyncio.to_thread(self._storage.upload_file, path, key, "application/json")

        return TranslateResult.model_validate(
            {
                "schemaVersion": 1,
                "jobId": job_id,
                "provider": provider,
                "sourceLanguage": source,
                "targetLanguage": target,
                "segmentCount": len(segments),
                "characters": characters,
                "artifacts": {"segments": {"bucket": self._storage.bucket, "objectKey": key, "etag": etag}},
            }
        ).model_dump(mode="json")
