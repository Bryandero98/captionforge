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
  quemar; los tiempos nunca cambian, solo el texto.
- **Elige un estilo de subtítulo** (Moderno, TikTok bold, Clásico
  YouTube, Minimalista) y, cuando los tiempos por palabra sobrevivieron
  (sin tocar por traducción o edición), activa el **resaltado karaoke
  palabra por palabra** para el quemado.
- **Quema en el video** - un paso aparte y bajo demanda de la
  transcripción - nunca te obliga a recodificar todo el video solo para
  obtener el texto.

**Trabajos recientes**, debajo de la tarjeta principal, recuerda tus
últimas 10 subidas en este navegador (`localStorage`) con enlaces de
redescarga directa para los cuatro formatos - útil cuando ya pasaste a un
video nuevo y el indicador de "trabajo actual" de arriba se movió contigo.

CaptionForge procesa un video a la vez por diseño - una segunda subida
mientras hay un trabajo en curso se rechaza con un error claro en vez de
encolarse o sobrescribirse en silencio. Editar y volver a quemar solo
están disponibles para ese trabajo actual; los trabajos anteriores en el
historial son solo de descarga (ver "Limitaciones conocidas").

## Cómo está construido

- `src/captionforge/srt.py` - formato y ensamblado puro para `.srt`,
  `.vtt`, y `.ass` con soporte karaoke (etiquetas `\k` por palabra cuando
  `Segment.words` sobrevivió a la traducción/edición), más la
  (de)serialización a diccionario plano usada para persistir segmentos en
  `segments.json`. Sin I/O.
- `src/captionforge/translate.py` - traducción local de segmentos ya
  cronometrados vía argos-translate, desacoplada de Whisper (cuya propia
  tarea `task="translate"` solo traduce hacia inglés). Descarta `words` en
  el texto traducido - los tiempos por palabra del idioma original ya no
  coinciden con él.
- `src/captionforge/ffmpeg_utils.py` - construcción pura del `argv` de
  ffmpeg (extracción de audio, quemado de subtítulos) - nunca ejecuta nada
  por sí mismo. `STYLE_PRESETS` (modern/tiktok/youtube/minimal) es la
  única fuente de verdad de la que se renderizan tanto el quemado plano
  con `force_style` como el quemado karaoke en `.ass`.
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
  (`GET`/`PUT .../segments`, solo el trabajo actual), y el quemado
  (campos de formulario `style`/`karaoke`).
- `src/captionforge/static/` - el frontend: una sola página plana de
  HTML/CSS/JS, sin paso de build, sin framework. `i18n.js` es un traductor
  simple basado en un diccionario plano (español/inglés, respaldado por
  `localStorage`) que controla cada elemento marcado con `data-i18n` en
  `index.html`; las etiquetas de etapa del trabajo se derivan en el
  cliente a partir del campo `status` (neutral en cuanto a idioma) que ya
  devuelve la API, no del propio `stage_label` del backend (que solo
  existe en español).

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
- El resaltado karaoke necesita tiempos por palabra, que se descartan para
  cualquier segmento traducido o editado a mano (las palabras ya no
  coinciden con el texto nuevo) - la casilla de karaoke simplemente se
  oculta cuando ningún segmento la tiene, y sigue funcionando para los que
  sí.
- "Trabajos recientes" vive en `localStorage`, así que es privado de un
  solo navegador - no sobrevive a borrar los datos del sitio y nunca se
  comparte entre dispositivos.
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
  Python ni ffmpeg preinstalados - empaquetar el runtime de Python
  (incluida la librería nativa CTranslate2 de `faster-whisper`) y un
  binario estático de ffmpeg en un solo ejecutable, con algo como
  PyInstaller, al estilo de cómo Ollama distribuye un único binario. El
  costo real no es el empaquetado en sí, sino la detección de GPU/CUDA por
  sistema operativo y la firma de código (para evitar los avisos de
  Windows SmartScreen / macOS Gatekeeper) - un esfuerzo comparable al de
  construir la app misma, por eso queda fuera de v1 a propósito.
- **Una versión hosteada** - CaptionForge necesita CPU (o GPU) real para
  Whisper/ffmpeg, así que un plan gratuito no alcanza para uso serio; un
  host de pago es el siguiente paso realista si algún día hay demanda de
  una opción "sin instalar nada". Ver "Apoya este proyecto" abajo.

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
