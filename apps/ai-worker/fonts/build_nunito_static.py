"""Genera Nunito-ExtraBold.ttf (instancia estática, wght=800) desde la fuente variable oficial de googlefonts/nunito (SIL OFL 1.1).

libass no maneja bien las fuentes variables, por eso se versiona la instancia estática. La licencia no declara nombre reservado (RFN), así
que la instancia puede llamarse igual. Uso (solo al actualizar la fuente; requiere `pip install fonttools`):
    python build_nunito_static.py "Nunito[wght].ttf" Nunito-ExtraBold.ttf
"""

import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

source, target = sys.argv[1], sys.argv[2]
font = TTFont(source)
static = instancer.instantiateVariableFont(font, {"wght": 800}, updateFontNames=True)
static.save(target)
print(f"{target}: {static['name'].getDebugName(1)} / {static['name'].getDebugName(2)}")
