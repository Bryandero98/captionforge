"""Paridad del contrato desde el lado Python (Pydantic).

Usa los MISMOS ejemplos que test/schemas.test.mjs (Ajv): lo que Node acepta, Python lo acepta,
y lo que uno rechaza, el otro también. Se valida con `model_validate_json(..., strict=True)`,
que es como debe hacerlo el worker: sin coerciones (p. ej. "5" no se convierte en 5).
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generated" / "python"))

SCHEMAS = ROOT / "schemas"
EXAMPLES = ROOT / "examples"


def _schema_name(example_file: Path) -> str:
    # "transcribe-job.v1.basic.json" -> "transcribe-job.v1"
    return ".".join(example_file.name.split(".")[:2])


def _model_for(schema_name: str):
    title = json.loads((SCHEMAS / f"{schema_name}.json").read_text(encoding="utf-8"))["title"]
    module = importlib.import_module(f"captionforge_contracts.{schema_name.replace('-', '_').replace('.', '_')}")
    return getattr(module, title)


def _examples(kind: str) -> list[Path]:
    return sorted((EXAMPLES / kind).glob("*.json"))


def test_every_message_schema_has_valid_and_invalid_examples() -> None:
    # Si faltara la carpeta de ejemplos, las pruebas parametrizadas quedarían vacías y pytest
    # saldría en verde sin probar nada: esto lo impide (igual que hace el lado Node).
    schemas = sorted(p.stem for p in SCHEMAS.glob("*.json") if not p.name.startswith("common."))
    assert len(schemas) >= 7
    for schema in schemas:
        for kind in ("valid", "invalid"):
            found = [e for e in _examples(kind) if _schema_name(e) == schema]
            assert found, f"{schema}: falta al menos un ejemplo en examples/{kind}"


def _normalize(value):
    """Pydantic serializa fechas como ...Z sin ceros de milisegundos: se compara por instante."""
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, str) and value.endswith("Z") and "T" in value:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    return value


@pytest.mark.parametrize("path", _examples("valid"), ids=lambda p: p.name)
def test_valid_examples_are_accepted_and_round_trip(path: Path) -> None:
    model = _model_for(_schema_name(path))
    raw = path.read_text(encoding="utf-8")
    parsed = model.model_validate_json(raw, strict=True)
    # Lo que entra es lo que sale: ningún campo se pierde ni se renombra.
    assert _normalize(parsed.model_dump(mode="json")) == _normalize(json.loads(raw))


@pytest.mark.parametrize("path", _examples("invalid"), ids=lambda p: p.name)
def test_invalid_examples_are_rejected(path: Path) -> None:
    model = _model_for(_schema_name(path))
    with pytest.raises(ValidationError):
        model.model_validate_json(path.read_text(encoding="utf-8"), strict=True)


def test_strict_mode_does_not_coerce_types() -> None:
    model = _model_for("transcribe-job.v1")
    body = json.loads((EXAMPLES / "valid" / "transcribe-job.v1.basic.json").read_text(encoding="utf-8"))
    body["input"]["sizeBytes"] = "734003200"  # un número como texto
    with pytest.raises(ValidationError):
        model.model_validate_json(json.dumps(body), strict=True)


def test_every_schema_has_a_generated_model() -> None:
    names = [p.stem for p in SCHEMAS.glob("*.json") if not p.name.startswith("common.")]
    assert len(names) >= 7
    for name in names:
        assert _model_for(name) is not None
