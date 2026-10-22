"""Genera public/js/domain/languages.js desde legacy/src/captionforge/languages.py.

La fuente es el diccionario WHISPER_LANGUAGE_NAMES del paquete heredado (sus códigos están fijados contra el
tokenizador de faster-whisper). Se lee con `ast`, sin importar faster_whisper.

  python scripts/gen-languages.py          escribe el archivo
  python scripts/gen-languages.py --check  falla si el archivo generado no coincide (para CI)
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "legacy" / "src" / "captionforge" / "languages.py"
TARGET = Path(__file__).resolve().parents[1] / "public" / "js" / "domain" / "languages.js"


def read_names() -> dict[str, str]:
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "WHISPER_LANGUAGE_NAMES":
            return ast.literal_eval(node.value)
    raise SystemExit("No se encontró WHISPER_LANGUAGE_NAMES en languages.py")


def render() -> str:
    names = read_names()
    rows = ",\n".join(f"  {{ code: {json.dumps(code)}, name: {json.dumps(name, ensure_ascii=False)} }}" for code, name in sorted(names.items(), key=lambda item: item[1]))
    return (
        "// GENERADO por scripts/gen-languages.py desde legacy/src/captionforge/languages.py. No editar a mano.\n"
        "// Los códigos son los que valida el tokenizador de faster-whisper (el API solo exige /^[a-z]{2,3}$/).\n\n"
        f"/** @type {{ readonly { '{' } code: string, name: string { '}' }[] }} */\n"
        f"export const LANGUAGES = [\n{rows},\n];\n"
    )


def main() -> None:
    text = render()
    if "--check" in sys.argv:
        if not TARGET.exists() or TARGET.read_text(encoding="utf-8") != text:
            raise SystemExit("languages.js no coincide con languages.py: ejecuta `python scripts/gen-languages.py`")
        print("languages.js al día")
        return
    TARGET.write_text(text, encoding="utf-8", newline="\n")
    print(f"escrito {TARGET} ({len(read_names())} idiomas)")


if __name__ == "__main__":
    main()
