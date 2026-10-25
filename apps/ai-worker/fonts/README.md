# Fuentes de los subtítulos dinámicos

| Archivo | Fuente | Licencia | Origen |
|---|---|---|---|
| `Montserrat-ExtraBold.ttf` | Montserrat ExtraBold (pesada) | SIL OFL 1.1 (`OFL-Montserrat.txt`) | https://github.com/JulietaUla/Montserrat (`fonts/ttf`) |
| `Nunito-ExtraBold.ttf` | Nunito ExtraBold (redondeada) | SIL OFL 1.1 (`OFL-Nunito.txt`) | instancia estática wght=800 de la fuente variable de https://github.com/googlefonts/nunito (`build_nunito_static.py`) |

Los `.ttf` son **estáticos** (libass no maneja bien las variables). Se verifican con `SHA256SUMS`. La imagen del worker los instala en
`/usr/share/fonts/truetype/captionforge/` y las plantillas (`ass_render.py`) piden exactamente esas familias.
