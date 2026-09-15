# CaptionForge

[English](README.md) | **Español**

Subtítulos automáticos para video, locales y gratuitos - la experiencia de
subtítulos automáticos de CapCut/Kapwing, pero 100% en tu propia máquina.
Sin marca de agua, sin límite mensual, sin cuenta.

Arrastra un video y recibe un archivo `.srt` y/o el video con los
subtítulos quemados, con un estilo moderno tipo redes sociales. La
transcripción corre en local vía
[faster-whisper](https://github.com/SYSTRAN/faster-whisper); la traducción
(a cualquier idioma, no solo inglés) corre en local vía
[argos-translate](https://github.com/argosopentech/argos-translate); el
quemado de subtítulos en el video usa [ffmpeg](https://ffmpeg.org/). Nada
sale de tu máquina.

## Requisitos

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/download.html) en tu `PATH`

## Instalación y uso

```sh
pip install -e ".[dev]"
captionforge serve
```

Esto levanta un servidor local (por defecto `http://127.0.0.1:8420/`) y lo
abre en tu navegador. El selector **ES / EN** en la esquina superior
derecha define el idioma de la interfaz (se recuerda para la próxima vez
vía `localStorage`; por defecto usa el idioma de tu navegador). Arrastra un
video, elige el tamaño del modelo de Whisper y, si quieres, un idioma de
origen o un idioma de traducción, y haz clic en **Generar subtítulos**.

Cuando termine la transcripción:

- **Descarga `.srt`, `.vtt` o `.ass`** directamente - los mismos
  segmentos, en tres formatos (`.vtt` para un `<video><track>` HTML plano,
  `.ass` para un editor que quiera estilos/karaoke reales).
- **Edita los subtítulos** - corrige un error de transcripción antes de
  quemar, y arrastra el inicio/fin de cada segmento directamente sobre una
  forma de onda para reajustar el tiempo. Las palabras que faster-whisper
  transcribió con baja confianza aparecen subrayadas (con un resaltado
  sutil) directo en el editor, para que sepas qué revisar en vez de
  confiar ciegamente en la transcripción.
- **Elige un estilo de subtítulo** (Moderno, TikTok bold, Clásico
  YouTube, Minimalista) y activa el **resaltado karaoke palabra por
  palabra** para el quemado - disponible siempre que un segmento tenga
  tiempos por palabra, ya sean los tiempos reales de faster-whisper o los
  tiempos aproximados (por longitud de carácter) que esta app sintetiza
  después de traducir o editar el texto de un segmento (ver "Limitaciones
  conocidas").
- **Quema en el video** - un paso aparte y bajo demanda de la
  transcripción - nunca te obliga a recodificar todo el video solo para
  obtener el texto.

**Trabajos recientes**, debajo de la tarjeta principal, recuerda tus
últimas 10 subidas en este navegador (`localStorage`) con enlaces de
redescarga directa para los cuatro formatos - útil cuando ya pasaste a un
video nuevo y el indicador de "trabajo actual" de arriba se movió contigo.

CaptionForge procesa un video a la vez por diseño en el backend - una
segunda subida mientras hay un trabajo en curso se rechaza con un error
claro en vez de sobrescribirse en silencio. El frontend se apoya en eso:
**selecciona o suelta varios videos a la vez** y quedan en una cola del
lado del navegador (nombre + estado: esperando/corriendo/listo/error), se
suben de a uno, avanzando automáticamente al siguiente archivo en cuanto
el actual llega a listo o error - así un archivo malo no bloquea el resto
del lote. Editar y volver a quemar solo están disponibles para el trabajo
actual (el último de una cola); los trabajos anteriores en el historial
son solo de descarga (ver "Limitaciones conocidas").

## Arquitectura

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
  <img src="docs/architecture-light.svg" alt="Diagrama: el navegador sube un video a FastAPI, que lo entrega a un pipeline en segundo plano que llama a ffmpeg, faster-whisper y argos-translate en orden, escribiendo los resultados en un directorio del trabajo en disco, mientras el navegador observa el progreso por un stream SSE separado, retransmitido desde JobStore.">
</picture>

La subida responde en milisegundos - el trabajo real corre como una tarea
en segundo plano mientras el navegador lo observa en vivo por un stream
SSE, no preguntando una y otra vez.

## Cómo está construido

- `src/captionforge/srt.py` - formato y ensamblado puro para `.srt`,
  `.vtt`, y `.ass` con soporte karaoke (etiquetas `\k` por palabra siempre
  que `Segment.words` esté presente). `WordTiming.probability` guarda la
  confianza real por palabra de faster-whisper (`None` solo para una
  palabra que esta app sintetizó, nunca para una transcripción real).
  `redistribute_word_timings()` es la heurística compartida de tiempo
  aproximado que usan tanto la traducción como la edición de texto en
  cuanto las palabras de un segmento ya no coinciden con su tiempo por
  palabra ORIGINAL - ver "Limitaciones conocidas" para el detalle exacto
  de qué garantiza y qué no. También la (de)serialización a diccionario
  plano usada para persistir segmentos en `segments.json`. Sin I/O.
- `src/captionforge/translate.py` - traducción local de segmentos ya
  cronometrados vía argos-translate, desacoplada de Whisper (cuya propia
  tarea `task="translate"` solo traduce hacia inglés). Los tiempos por
  palabra del idioma ORIGINAL no pueden sobrevivir a una traducción
  (distintas palabras, cantidad y a menudo orden) - en vez de descartar el
  tiempo por palabra por completo, `redistribute_word_timings()` aproxima
  un tiempo nuevo para el texto traducido.
- `src/captionforge/waveform.py` + `ffmpeg_utils.build_waveform_extract_cmd`
  - datos de amplitud de audio submuestreados para el fondo de forma de
  onda del editor: un solo paso de ffmpeg decodifica y remuestrea el video
  original de un trabajo a PCM crudo de 8 bits a una tasa de muestreo baja
  y fija, agrupado en como máximo 2000 picos antes de enviarse al
  navegador.
- `src/captionforge/ffmpeg_utils.py` - construcción pura del `argv` de
  ffmpeg (extracción de audio, quemado de subtítulos, extracción de forma
  de onda) - nunca ejecuta nada por sí mismo. `STYLE_PRESETS`
  (modern/tiktok/youtube/minimal) es la única fuente de verdad de la que
  se renderizan tanto el quemado plano con `force_style` como el quemado
  karaoke en `.ass`.
- `src/captionforge/jobs.py` - una máquina de estados de trabajo en
  memoria, thread-safe (`queued -> extracting_audio -> transcribing ->
  done -> burning_subtitles -> burned`, o `error` desde cualquier estado).
  Guarda UN solo trabajo a la vez por diseño - `segments.json` y los
  archivos de salida persistidos en disco (no este store en memoria) son
  lo que permite que el historial de "trabajos recientes" siga
  funcionando después de que un trabajo más nuevo tome su lugar.
- `src/captionforge/pipeline.py` - orquesta todo lo anterior: ffmpeg corre
  vía `asyncio.create_subprocess_exec`, Whisper/Argos (bloqueantes, uso
  intensivo de CPU) corren en un hilo aparte vía `asyncio.to_thread`, para
  que el servidor siga respondiendo (incluido el stream de progreso en
  vivo) mientras se procesa un video. Escribe `segments.json` junto al
  `.srt`; el quemado karaoke construye un `karaoke.ass` a partir de él
  bajo demanda.
- `src/captionforge/app.py` + `routes/` - la capa de FastAPI: subida,
  Server-Sent Events para el progreso en vivo, las descargas de
  `.srt`/`.vtt`/`.ass`/video (con un respaldo por existencia en disco para
  un trabajo que ya no es el que JobStore rastrea - seguro porque el
  diseño de un-trabajo-a-la-vez de CaptionForge garantiza que cualquier
  trabajo anterior ya llegó a un estado terminal), edición de segmentos
  (`GET`/`PUT .../segments`, solo el trabajo actual - `PUT` acepta `text`
  y/o `start`/`end` para un reajuste por arrastre de forma de onda),
  `GET .../waveform` (funciona para cualquier trabajo, actual o histórico -
  solo necesita el video original), y el quemado (campos de formulario
  `style`/`karaoke`).
- `src/captionforge/static/` - el frontend: una sola página plana de
  HTML/CSS/JS, sin paso de build, sin framework. `i18n.js` es un traductor
  simple basado en un diccionario plano (español/inglés, respaldado por
  `localStorage`) que controla cada elemento marcado con `data-i18n` en
  `index.html`; las etiquetas de etapa del trabajo se derivan en el
  cliente a partir del campo `status` (neutral en cuanto a idioma) que ya
  devuelve la API, no del propio `stage_label` del backend (que solo
  existe en español). El editor de segmentos (`app.js`) dibuja la forma de
  onda en un `<canvas>` con manijas arrastrables de inicio/fin por
  segmento, y subraya cualquier palabra por debajo de un umbral de
  confianza usando el `probability` por palabra que devuelve la API.

`scripts/smoke_test_pipeline.py` ejercita todo el pipeline transcribir ->
traducir -> quemar directamente contra un video real, sin servidor de por
medio - la forma más rápida de verificar el núcleo después de tocar
cualquier cosa relacionada con Whisper/ffmpeg/Argos.

## Desarrollo

```sh
python -m venv .venv
source .venv/Scripts/activate   # o .venv/bin/activate en Linux/macOS
pip install -e ".[dev]"
pytest
```

`tests/fixtures/tiny_test_clip.mp4` es un clip real de ~10s (voz
sintetizada) usado por las pruebas del pipeline en vivo - no es un mock.

## Build empaquetado (primer paso)

Un primer paso deliberadamente acotado hacia el instalador empaquetado del
issue #2 - **no** el instalador completo multiplataforma, firmado y
consciente de GPU que describe la "Hoja de ruta" más abajo.

```sh
pip install -e ".[build]"
python scripts/build_installer.py
```

Esto produce un único ejecutable `dist/captionforge` (`.exe` en Windows)
vía PyInstaller, manejado por `scripts/captionforge.spec` (la
configuración de build comentada y reproducible) a partir del entry point
`scripts/pyinstaller_entrypoint.py` - lo mismo que hace `captionforge
serve` (abrir el navegador, servir en el puerto por defecto con el modelo
por defecto), sin argparse, ya que un ejecutable empaquetado no tiene una
terminal a la que pasarle flags.

Qué cubre:

- **Una sola plataforma a la vez** - la que sea que corras el script de
  build. PyInstaller no compila de forma cruzada; una máquina Windows
  solo produce un ejecutable de Windows, igual para Linux/macOS.
- **Solo CPU** - empaqueta el backend de faster-whisper/ctranslate2 que
  ya esté instalado en el venv de build, sin CUDA/cuDNN.

Qué deliberadamente NO cubre todavía (ver la discusión del propio issue #2
sobre por qué cada uno de estos es un trabajo separado y no trivial):

- **Varias plataformas desde un solo lugar** - construir/distribuir
  Windows + macOS + Linux juntos.
- **Firma de código** - el ejecutable generado dispara los avisos de
  Windows SmartScreen / macOS Gatekeeper en el primer uso.
- **Selección de build GPU/CUDA** - sin detección de GPU por SO ni una
  variante con GPU.
- **Empaquetar ffmpeg** - el ejecutable generado sigue esperando
  `ffmpeg` en el `PATH`, igual que corriendo desde el código fuente.

## Limitaciones conocidas

- El `compute_type="auto"` por defecto de `argos-translate` resuelve a un
  kernel cuantizado que produce en silencio texto basura (bucle de
  repetición) para al menos un par de idiomas en al menos una CPU real -
  verificado en vivo durante el desarrollo. `captionforge` fuerza
  `float32` (ver `translate.py`) para evitar esto; si usas
  `argos-translate` directamente en otro lugar, verifica que tu propio par
  de idiomas no esté afectado antes de confiar en la salida cuantizada.
- El selector de idioma de la interfaz es solo del frontend. El texto de
  uso cotidiano (etiquetas de etapa, mensajes de error genéricos) es
  totalmente bilingüe, pero el mensaje de error poco frecuente que genera
  el servidor - un formato de archivo no soportado, un conflicto de
  trabajo, un fallo de ffmpeg - todavía lo escribe el backend en español y
  se muestra tal cual, sin importar el idioma elegido en la interfaz.
- Editar subtítulos y volver a quemar solo están disponibles para el
  trabajo ACTUAL - en cuanto empieza una subida nueva, JobStore olvida la
  anterior (por diseño; ver jobs.py), así que un trabajo más antiguo en
  "trabajos recientes" solo ofrece descargas. Esto coincide con el flujo
  natural (transcribir -> opcionalmente editar -> quemar) y con la
  máquina de estados de un-trabajo-a-la-vez, que no tiene camino de vuelta
  desde BURNED.
- El resaltado karaoke necesita tiempos por palabra. Un segmento traducido
  o editado a mano recibe tiempos por palabra APROXIMADOS en vez de los
  originales (reales): `redistribute_word_timings()` reparte el intervalo
  [start, end) existente del segmento entre las palabras del texto nuevo,
  proporcionalmente por longitud de carácter - un sustituto barato y
  honesto para una alineación forzada real, no uno verificado
  acústicamente. NO está sincronizado labialmente: las palabras de una
  oración traducida rara vez caen donde realmente ocurre el sonido
  correspondiente, especialmente para pares de idiomas con orden de
  palabras muy distinto. Toda palabra que esta app sintetiza así tiene
  `probability: null` en la respuesta de la API de segmentos,
  específicamente para que nada la confunda con una confianza de
  transcripción real. La casilla de karaoke simplemente se oculta cuando
  ningún segmento tiene tiempos por palabra (reales o aproximados).
  Una alineación forzada real (un modelo estilo wav2vec2, como hace
  [WhisperX](https://github.com/m-bain/whisperX)) arreglaría esto
  correctamente, al costo de una dependencia de modelo nueva por completo
  - fuera de alcance por ahora; ver los issues de diarización/separación
  de voz más abajo para el mismo dilema de "nueva dependencia pesada de
  ML" aplicado a otras dos funciones.
- El resaltado de palabras de baja confianza en el editor es tan bueno
  como la `probability` por palabra de faster-whisper - una palabra puede
  estar mal transcrita con confianza (se oye mal pero se pronuncia claro)
  o bien transcrita sin confianza (correcta a pesar de audio ruidoso).
  Trata el subrayado como "vale la pena revisar", no como garantía de
  corrección.
- Las manijas de arrastre del editor de forma de onda te dejan encoger o
  agrandar un segmento libremente; no hay validación contra el inicio/fin
  de un segmento VECINO, así que es posible arrastrar dos segmentos a
  rangos de tiempo superpuestos (o con huecos). Nada se rompe, pero
  revisa el resultado antes de quemar si haces un ajuste grande.
- "Trabajos recientes" vive en `localStorage`, así que es privado de un
  solo navegador - no sobrevive a borrar los datos del sitio y nunca se
  comparte entre dispositivos.
- La cola de subida vive solo en la memoria de la página - recargar a
  mitad de un lote retoma el archivo que se estaba subiendo (igual que
  cualquier trabajo individual), pero los archivos que aún esperaban en
  cola se pierden; vuelve a seleccionarlos para continuar.
- Los archivos de un trabajo (video, `.srt`/`.vtt`/`.ass`, `segments.json`)
  se borran automáticamente 7 días después de la última escritura - cada
  subida nueva limpia lo que ya pasó ese tiempo. Una entrada puede
  sobrevivir más que sus archivos en "trabajos recientes" (que no tiene
  vencimiento propio); sus enlaces de descarga simplemente devuelven 404
  cuando eso pasa.

## Hoja de ruta

Ideas que vale la pena hacer eventualmente, deliberadamente sin empezar
todavía:

- **Un instalador nativo empaquetado** (`.exe` en Windows, `.dmg` en
  macOS, `.AppImage`/`.deb` en Linux) para que un usuario no necesite tener
  Python ni ffmpeg preinstalados. Ya existe un primer paso acotado (ver
  "Build empaquetado (primer paso)" más arriba: una sola plataforma,
  solo CPU, sin firmar, sin ffmpeg incluido). Lo que falta - distribuir
  varias plataformas desde un solo lugar, empaquetar un ffmpeg estático
  por sistema operativo, detección de GPU/CUDA por SO, y la firma de
  código (para evitar los avisos de Windows SmartScreen / macOS
  Gatekeeper) - es un esfuerzo comparable al de construir la app misma,
  por eso queda fuera de v1 a propósito.
- **Una versión hosteada** - CaptionForge necesita CPU (o GPU) real para
  Whisper/ffmpeg, así que un plan gratuito no alcanza para uso serio; un
  host de pago es el siguiente paso realista si algún día hay demanda de
  una opción "sin instalar nada". Ver "Apoya este proyecto" abajo.
- **Diarización de hablantes** ("quién dijo qué") vía
  [pyannote.audio](https://github.com/pyannote/pyannote-audio) - ver el
  [issue #4](https://github.com/Bryandero98/captionforge/issues/4) para el
  motivo de por qué queda diferido: una segunda dependencia pesada de ML
  basada en PyTorch, más la fricción real de los modelos con puerta de
  Hugging Face de pyannote (una cuenta + aceptar términos + un token de
  acceso personal, a diferencia de las descargas anónimas de
  faster-whisper de hoy).
- **Separación de voz/fuente antes de transcribir** (vía
  [Demucs](https://github.com/facebookresearch/demucs)) para audio ruidoso
  o con mucha música - ver el
  [issue #5](https://github.com/Bryandero98/captionforge/issues/5) para el
  motivo de por qué queda diferido: una tercera dependencia pesada de ML,
  costo real de tiempo de ejecución agregado para el caso común (diálogo
  limpio) que no lo necesita, y un compromiso de calidad que necesita
  comparación real antes/después, no solo la suposición de que separar
  siempre ayuda.
- **Alineación forzada real** después de traducir o editar texto a mano
  (un modelo estilo wav2vec2, como hace WhisperX) - la redistribución
  aproximada de tiempos por palabra (por longitud de carácter) de hoy (ver
  "Limitaciones conocidas") es un sustituto deliberadamente barato para
  esto, no un reemplazo.
- **Una cola de backend paralela real** (procesar más de un video a la
  vez) - CaptionForge es de un-trabajo-a-la-vez por diseño hoy (ver
  `jobs.py` y la propia cola de subida del frontend, que sube de forma
  secuencial precisamente porque el backend solo puede correr un trabajo a
  la vez). Vale la pena hacerlo eventualmente en una máquina multi-núcleo,
  pero es un cambio genuinamente más grande (pool de workers, límites de
  recursos por trabajo, una cola que sobreviva a un reinicio del servidor)
  que cualquier otra cosa en esta lista - sin plan concreto todavía, solo
  se anota aquí para que no se confunda con un descuido.

## Apoya este proyecto

CaptionForge es gratis y local por diseño, y va a seguir siéndolo. Una
propina no desbloquea nada - va destinada a eventualmente pagar un host
real, para que quien no quiera instalar nada también tenga esa opción:

- **Ko-fi:** [ko-fi.com/bryandero98](https://ko-fi.com/bryandero98)
- **USDT (TRC20):** `TEG4Kk2qXYMQ4mHNd7dPhSPRyT14CGr2or` - verifica que la
  red esté configurada en **TRC20** antes de enviar; una transferencia en
  la red equivocada no se puede recuperar.

## Ideas y contribuciones

Las sugerencias sobre qué debería hacer CaptionForge a futuro son
bienvenidas, no solo los reportes de bugs - abre un issue con lo que te
gustaría ver, aunque sea una idea a medio pulir. Ver
[CONTRIBUTING.md](./CONTRIBUTING.md) para cómo enviar un PR.
