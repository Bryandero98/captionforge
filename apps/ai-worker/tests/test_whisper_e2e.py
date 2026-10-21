"""Whisper REAL de punta a punta. Se omite salvo con WHISPER_E2E=1 (necesita el modelo `base` en caché
o red para descargarlo, y tarda): las demás pruebas simulan Whisper porque no aporta al contrato."""

from __future__ import annotations

import json
import os

import pytest
from captionforge_contracts import TranscribeResult

from ai_worker.models import ModelProvider

from test_pipeline import read_object, run_job

pytestmark = pytest.mark.skipif(os.environ.get("WHISPER_E2E") != "1", reason="define WHISPER_E2E=1 para usar Whisper real")


def test_real_whisper_produces_a_valid_result_and_artifacts(config, storage, new_job) -> None:  # noqa: ANN001
    _, payload = new_job(options={"modelSize": "base"})
    models = ModelProvider()  # carga el modelo real una vez
    result = run_job(config, storage, models, payload)

    TranscribeResult.model_validate_json(json.dumps(result), strict=True)
    assert result["device"] in {"cpu", "cuda"}
    # El video de prueba puede no tener voz: lo que importa es que el pipeline cierre bien y suba los tres artefactos.
    json.loads(read_object(storage, result["artifacts"]["segments"]["objectKey"]))
    json.loads(read_object(storage, result["artifacts"]["waveform"]))
    read_object(storage, result["artifacts"]["srt"])
    assert models.loads == 1
