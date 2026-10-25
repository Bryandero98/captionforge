# Avisos de terceros

CaptionForge incluye o ejecuta los componentes siguientes. Cada uno conserva su propia licencia.

## Fuentes de los subtítulos dinámicos (en la imagen del worker)

| Fuente | Licencia | Texto de la licencia | Origen |
|---|---|---|---|
| Montserrat ExtraBold | SIL Open Font License 1.1 | [`OFL-Montserrat.txt`](apps/ai-worker/fonts/OFL-Montserrat.txt) | https://github.com/JulietaUla/Montserrat |
| Nunito ExtraBold | SIL Open Font License 1.1 | [`OFL-Nunito.txt`](apps/ai-worker/fonts/OFL-Nunito.txt) | https://github.com/googlefonts/nunito |

La OFL permite usar, estudiar, copiar y redistribuir las fuentes (también dentro de un producto) siempre que se conserve su aviso de
derechos y su licencia. `Nunito-ExtraBold.ttf` es una instancia estática (peso 800) generada con `fontTools` a partir de la fuente
variable original (`apps/ai-worker/fonts/build_nunito_static.py`); no cambia el diseño. Los hashes de los archivos están en
[`SHA256SUMS`](apps/ai-worker/fonts/SHA256SUMS) y la integración continua los verifica.

## ffmpeg

El worker ejecuta ffmpeg (paquete `imageio-ffmpeg`) como **proceso aparte** a través de la línea de comandos; no enlaza sus bibliotecas
`libav*`. Su código fuente y su licencia (GPL/LGPL según la compilación) están en https://ffmpeg.org/ y en https://github.com/imageio/imageio-binaries.
