"""Recorta las fuentes del motor de render al alfabeto latino para la vista previa de los temas (public/fonts/*.woff).

  python scripts/subset-fonts.py

Necesita `fonttools` (sin brotli: se escribe WOFF, comprimido con zlib). Después hay que actualizar SHA256SUMS:
  cd public/fonts && sha256sum *.woff OFL-*.txt > SHA256SUMS
"""

from __future__ import annotations

from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parents[1] / "public" / "fonts"
UNICODES = "U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2013-2014,U+2018-201D,U+2026,U+20AC"
FONTS = {"Montserrat-ExtraBold": "montserrat-800-latin", "Nunito-ExtraBold": "nunito-800-latin"}


def main() -> None:
    for source, target in FONTS.items():
        options = subset.Options()
        options.flavor = "woff"
        options.layout_features = ["*"]
        options.name_IDs = [1, 2, 3, 4, 6]
        options.notdef_outline = True
        font = TTFont(ROOT / "apps" / "ai-worker" / "fonts" / f"{source}.ttf")
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
        subsetter.subset(font)
        font.flavor = "woff"
        font.save(OUT / f"{target}.woff")
        print(f"escrito {target}.woff")


if __name__ == "__main__":
    main()
