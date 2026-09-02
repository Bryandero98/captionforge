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
Cuando termine la transcripción puedes descargar el `.srt` directamente, o
hacer clic en **Quemar en el video** para grabar los subtítulos en el
video mismo (un paso aparte y bajo demanda - nunca te obliga a recodificar
todo el video solo para obtener el texto).

CaptionForge procesa un video a la vez por diseño - una segunda subida
mientras hay un trabajo en curso se rechaza con un error claro en vez de
encolarse o sobrescribirse en silencio.

## Cómo está construido

- `src/captionforge/srt.py` - formato y ensamblado puro de timestamps de
  `.srt`, sin I/O.
- `src/captionforge/translate.py` - traducción local de segmentos ya
  cronometrados vía argos-translate, desacoplada de Whisper (cuya propia
  tarea `task="translate"` solo traduce hacia inglés).
- `src/captionforge/ffmpeg_utils.py` - construcción pura del `argv` de
  ffmpeg (extracción de audio, quemado de subtítulos con estilo negrita
  blanca / borde negro) - nunca ejecuta nada por sí mismo.
- `src/captionforge/jobs.py` - una máquina de estados de trabajo en
  memoria, thread-safe (`queued -> extracting_audio -> transcribing ->
  done -> burning_subtitles -> burned`, o `error` desde cualquier estado).
- `src/captionforge/pipeline.py` - orquesta todo lo anterior: ffmpeg corre
  vía `asyncio.create_subprocess_exec`, Whisper/Argos (bloqueantes, uso
  intensivo de CPU) corren en un hilo aparte vía `asyncio.to_thread`, para
  que el servidor siga respondiendo (incluido el stream de progreso en
  vivo) mientras se procesa un video.
- `src/captionforge/app.py` + `routes/` - la capa de FastAPI: subida,
  Server-Sent Events para el progreso en vivo, y las descargas de
  `.srt`/video.
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
