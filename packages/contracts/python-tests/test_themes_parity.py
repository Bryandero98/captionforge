"""Paridad del catálogo de temas con los motores reales de render.

Lee el catálogo (`themes.v1.json`) y lo compara con las tablas que usa el worker, SIN importar el worker:
  - plantillas ASS: `TEMPLATES` de apps/ai-worker/src/ai_worker/ass_render.py
  - estilos clásicos: `STYLE_PRESETS` de legacy/src/captionforge/ffmpeg_utils.py
Si alguien cambia un color o un tamaño en el motor sin actualizar la vista previa, esta prueba falla.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CATALOGUE = json.loads((ROOT / "packages" / "contracts" / "themes.v1.json").read_text(encoding="utf-8"))
THEMES = {theme["id"]: theme for theme in CATALOGUE["themes"]}
TOLERANCE = 1.5e-6
# Las fuentes de los temas con su familia en el motor.
FONT_OF = {"Montserrat ExtraBold": "montserrat", "Nunito ExtraBold": "nunito", "Arial": "arial"}


def _rgb(ass: str) -> str:
    """&HAABBGGRR -> #RRGGBB (el orden de ASS es azul, verde, rojo)."""
    value = ass.removeprefix("&H")
    return ("#" + value[6:8] + value[4:6] + value[2:4]).upper()


def _rgba(ass: str) -> str:
    """&HAABBGGRR -> #RRGGBBAA, donde el alfa de ASS está invertido (00 = opaco)."""
    value = ass.removeprefix("&H")
    return _rgb(ass) + f"{255 - int(value[0:2], 16):02X}"


def _templates() -> dict[str, tuple[list, dict]]:
    tree = ast.parse((ROOT / "apps" / "ai-worker" / "src" / "ai_worker" / "ass_render.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "TEMPLATES":
            return {
                ast.literal_eval(key): ([ast.literal_eval(a) for a in call.args], {k.arg: ast.literal_eval(k.value) for k in call.keywords})
                for key, call in zip(node.value.keys, node.value.values)
            }
    raise AssertionError("No se encontró TEMPLATES en ass_render.py")


def _presets() -> dict[str, dict]:
    tree = ast.parse((ROOT / "legacy" / "src" / "captionforge" / "ffmpeg_utils.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "STYLE_PRESETS":
            return ast.literal_eval(node.value)
    raise AssertionError("No se encontró STYLE_PRESETS en ffmpeg_utils.py")


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= TOLERANCE


@pytest.mark.parametrize("theme", [t for t in CATALOGUE["themes"] if t["group"] == "vertical"], ids=lambda t: t["id"])
def test_la_plantilla_ass_coincide_con_su_tema(theme):
    args, kwargs = _templates()[theme["burn"]["template"]]
    _id, font, mode, max_words, size_ratio, margin_ratio, primary, secondary, outline_colour, _back, outline, shadow = args
    preview = theme["preview"]
    assert preview["font"] == FONT_OF[font]
    assert preview["mode"] == mode
    assert preview["maxWords"] == max_words
    assert _close(preview["sizeRatio"], size_ratio)
    assert _close(preview["marginRatio"], margin_ratio)
    assert _close(preview["outlineRatio"], outline / 1000)
    assert _close(preview["shadowRatio"], shadow / 1920)
    assert preview["upper"] == kwargs.get("upper", False)
    assert preview["popScale"] == kwargs.get("pop_scale", 118)
    # La palabra ya cantada o activa va de color primario; el texto todavía sin decir, del secundario.
    assert preview["lit"] == _rgb(primary)
    assert preview["base"] == _rgb(secondary)
    assert preview["outline"] == _rgb(outline_colour)
    assert preview["box"] is None
    assert preview["bold"] is True


@pytest.mark.parametrize("theme", [t for t in CATALOGUE["themes"] if t["group"] == "source"], ids=lambda t: t["id"])
def test_el_estilo_clasico_coincide_con_su_tema(theme):
    preset = _presets()[theme["burn"]["style"]]
    preview = theme["preview"]
    assert preview["font"] == FONT_OF[preset["font_name"]]
    assert preview["bold"] == bool(preset["bold"])
    # ffmpeg convierte un .srt a ASS con PlayResY = 288: los tamaños del preset son fracciones de 288.
    assert _close(preview["sizeRatio"], preset["font_size"] / 288)
    assert _close(preview["marginRatio"], preset["margin_v"] / 288)
    assert _close(preview["outlineRatio"], preset["outline"] / 288)
    assert _close(preview["shadowRatio"], preset["shadow"] / 288)
    assert preview["base"] == preview["lit"] == _rgb(preset["primary_colour"])
    assert preview["outline"] == _rgb(preset["outline_colour"])
    # BorderStyle 3 es una caja opaca detrás del texto (con el color de fondo del preset).
    assert preview["box"] == (_rgba(preset["back_colour"]) if preset["border_style"] == 3 else None)
    # En el karaoke ASS el secundario es el texto aún sin cantar y el primario el ya cantado.
    assert preview["karaoke"] == {"base": _rgb(preset["secondary_colour"]), "lit": _rgb(preset["primary_colour"])}
