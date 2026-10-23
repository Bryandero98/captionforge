"""Registro JSON del worker (ADR 0018): una línea por evento, sin posibilidad de falsificar otra línea."""

from __future__ import annotations

import json
import logging

import pytest

from ai_worker.logfmt import JsonFormatter, configure_logging


def _record(message: str, *args: object, level: int = logging.INFO, exc_info=None) -> logging.LogRecord:
    return logging.LogRecord("ai_worker", level, __file__, 1, message, args, exc_info)


def test_una_linea_json_con_los_mismos_campos_que_el_api() -> None:
    line = JsonFormatter().format(_record("trabajo %s listo", "abc"))
    data = json.loads(line)
    assert data["level"] == "info"
    assert data["context"] == "ai_worker"
    assert data["msg"] == "trabajo abc listo"
    assert data["time"].endswith("Z")
    assert "\n" not in line


def test_los_niveles_usan_los_nombres_del_api() -> None:
    names = {logging.WARNING: "warn", logging.ERROR: "error", logging.CRITICAL: "fatal", logging.DEBUG: "debug"}
    for level, expected in names.items():
        assert json.loads(JsonFormatter().format(_record("x", level=level)))["level"] == expected


def test_un_valor_con_saltos_de_linea_no_puede_falsificar_otra_linea() -> None:
    hostile = 'ok\n{"level":"info","msg":"falso"}'
    line = JsonFormatter().format(_record("archivo %s", hostile))
    assert "\n" not in line
    assert json.loads(line)["msg"] == f"archivo {hostile}"


def test_una_excepcion_va_en_stack() -> None:
    try:
        raise RuntimeError("falló")
    except RuntimeError:
        import sys

        data = json.loads(JsonFormatter().format(_record("boom", level=logging.ERROR, exc_info=sys.exc_info())))
    assert "RuntimeError: falló" in data["stack"]


def test_un_formato_desconocido_falla_al_configurar() -> None:
    with pytest.raises(ValueError, match="LOG_FORMAT"):
        configure_logging("xml")
