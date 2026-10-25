# Plan de implementación: Issue #13, parte 2 (subtítulos dinámicos ASS y formato vertical 9:16)

Rama: `feat/issue-13-ass-styles` (desde `main` en v1.1.0 + CHANGELOG). Estado: **borrador de diseño para revisión técnica, sin código**.
Tareas en [todo.md](todo.md). La parte 1 (control de calidad, T1 a T5) ya está en `main` (ADR 0021, PR #30 y siguientes). El ADR de esta parte será el **0024**
(el 0022 y el 0023 ya los ocupan Multi-LLM y audio).

## Entregable

Un **motor de renderizado de subtítulos para redes sociales**: de una transcripción terminada saca un `.mp4` vertical 9:16 (1080×1920), con el video original
centrado sobre un fondo desenfocado de sí mismo, y subtítulos de pocas palabras por pantalla con **resaltado karaoke palabra por palabra**. Todo local, sin costo por uso.

## Hechos del código que condicionan el diseño (verificados en esta sesión)

| Hecho | Consecuencia |
|---|---|
| `GET /v1/jobs/:id/segments` **ya devuelve `words`** (`segments.ts` los valida: orden, tope `MAX_WORDS`) y el worker los guarda en `segments.json` | No hay endpoint nuevo: el API y el worker leen la misma fuente. Falta formalizar el tipo en `packages/contracts` y normalizarlos |
| `burn.py` usa `segments_to_ass(segments, resolve_style(style))` (legacy `srt.py`) con **un solo `Style: Default`** y `\k` por palabra, y `build_burn_subtitles_cmd(..., is_ass=True)` con `-vf subtitles=` | Se sustituye por un generador propio con plantillas; el camino SRT y el karaoke actuales **no cambian** si no se pide plantilla |
| `build_burn_subtitles_cmd` no fija códec, `-map` ni límites de hilos | El grafo 9:16 necesita un comando propio y explícito (abajo) |
| `_run_ffmpeg` lanza `asyncio.create_subprocess_exec` con **argv en lista**, entorno de **lista blanca** (`ffmpeg_env`: incluye `FONTCONFIG_FILE`/`FONTCONFIG_PATH`), `stall_timeout` y `total_timeout`, y mata al hijo al cancelar | Es el marco de aislamiento: el nuevo filtro lo respeta tal cual (ver «Composición») |
| Editar o traducir el texto **descarta** `words`; hoy el quemado cae a subtítulo completo | Política de texto editado (decisión 4) |
| Imagen del worker: `fontconfig`, `fonts-dejavu-core`, `fonts-liberation`; usuario `worker`, `/work` volumen, memoria 4 GiB | Las fuentes nuevas se añaden a la imagen (pilar 3) |
| El quemado es un trabajo hijo con `parentJobId`, ETag de segmentos y 409 si ya hay uno | Se reutiliza; no hay tipo de trabajo nuevo |

## Pilar 1: generación ASS (de `GET /segments` al `.ass`)

**Flujo de datos** (el cliente no manda tiempos; manda solo *qué* quiere):

```
UI → POST /v1/jobs/:id/burn { style, karaoke, template?, canvas? }
API  valida (lista blanca) + ETag de segments.json → BurnJob (campos opcionales nuevos, schemaVersion 1)
Worker: lee segments.json por ETag (los mismos datos que devolvió GET /segments, con `words`)
        → normalize_words → resolver texto editado → paginar → render_ass(plantilla) → ffmpeg
```

1. **Contrato (aditivo):** `Segment` y `Word` formales en `packages/contracts` (`words` opcional); `burn-job` gana `template` (enum de fábrica) y `canvas`
   (`"source" | "vertical"`), ambos opcionales. Sin ellos, el comportamiento actual es idéntico (compatibilidad probada).
2. **`normalize_words`** (puro): ordena, recorta cada palabra al segmento, elimina solapes y huecos negativos; si no queda un conjunto coherente, descarta las
   palabras de ese segmento y lo informa. La salida decide `usedKaraoke` por segmento, no global.
3. **Texto editado (decisión 4):** si `words` falta o su texto ya no coincide, se alinea con `difflib` palabra a palabra contra las originales cuando existan; las que
   coinciden conservan su tiempo, el resto se reparte proporcionalmente al largo. Los segmentos así quedan marcados `approximate` y el resultado lo informa (`approximateSegments`).
4. **Paginación:** cada segmento se parte en *pantallas* de `N` palabras (1 a 4 según plantilla) cortando preferentemente tras puntuación; el tiempo de cada pantalla
   sale de los tiempos reales (inicio de su primera palabra, fin de su última, con un mínimo de 0,35 s y sin invadir la siguiente).
5. **`render_ass(pantallas, plantilla, lienzo)`** (puro, sin E/S):
   - `[Script Info]` con `PlayResX/PlayResY` = lienzo (1080×1920 o el del video), `ScaledBorderAndShadow: yes`, `WrapStyle: 2`.
   - Un `Style` por plantilla (fuente, tamaño relativo a la altura, colores `&HAABBGGRR`, contorno, sombra, alineación 2 o 5, `MarginV` en el tercio inferior para 9:16).
   - Resalte: `sweep` = un `Dialogue` por pantalla con `\kf` por palabra; `pop` = un `Dialogue` por palabra con la pantalla completa y la palabra activa con `{\c&H…&\fscx118\fscy118}`
     más `\t(0,90,…)` (rebote corto); `color` = igual que `pop` sin escala. Las palabras no dichas aún usan `SecondaryColour`.
   - **Escape obligatorio** del texto de usuario: `\`, `{`, `}` y saltos (`\N`) antes de componer; nadie puede inyectar etiquetas de override ni líneas de evento desde el texto. Pruebas con cargas hostiles.
   - Plantillas de fábrica en JSON validado (lista blanca de claves y rangos) bajo `packages/contracts/ass-templates/*.v1.json`: `bold-pop` (pesada, amarillo sobre blanco, `pop`), `rounded-sweep` (redondeada, barrido), `clean-color` (cambio de color). El nombre de plantilla del API es un enum, nunca una ruta.

## Pilar 2: composición visual (FFmpeg, un solo pase)

Entrada 16:9 (o cualquier proporción) → salida 1080×1920. El fondo se desenfoca **a baja resolución y luego se amplía** (el desenfoque a 1080×1920 sería 16 veces más caro y no se nota), y los
subtítulos se queman **al final**, sobre el lienzo ya compuesto, para que sus coordenadas sean las de 9:16:

```
ffmpeg -y -v error -hide_banner
  -i <job_dir>/input.bin
  -filter_threads 2 -filter_complex_threads 2
  -filter_complex "
    [0:v]split=2[bg][fg];
    [bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=luma_radius=12:luma_power=2,scale=1080:1920:flags=bicubic,setsar=1[bgb];
    [fg]scale=1080:-2:flags=lanczos,setsar=1[fgs];
    [bgb][fgs]overlay=x=(W-w)/2:y=(H-h)/2:format=auto,
    ass=filename=<job_dir>/captions.ass:fontsdir=/usr/share/fonts/truetype/captionforge[v]"
  -map "[v]" -map 0:a:0?
  -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -r <fps de origen, tope 30>
  -c:a aac -b:a 160k -movflags +faststart
  -t <tope de duración> <job_dir>/captioned.mp4
```

- **Variantes por proporción** (decide `probe_dimensions`, que lee `ffmpeg -i` como ya hace `has_video_stream`): si la entrada ya es vertical (`w/h ≤ 9/16`) se omite el fondo y se escala/rellena a 1080×1920;
  si es más ancha que alta se usa el grafo de arriba; la rotación del contenedor la aplica ffmpeg sola. `canvas: "source"` conserva el comportamiento actual (solo `ass=` sobre el video).
- **Un solo pase:** una lectura, un codificado. `split` evita abrir la entrada dos veces; el audio se mapea con `0:a:0?` (un video sin audio no falla) y se recodifica a AAC (`-c copy` no es compatible con `faststart` + tope `-t` fiable).
- **Memoria y CPU acotadas:** `-filter_threads`/`-filter_complex_threads 2`, `-preset veryfast`, fondo procesado a 270×480; el contenedor ya limita a 4 GiB y un trabajo a la vez (`worker.py`). Se mide RAM y tiempo sobre un clip real (criterio de salida).
- **Respeta el aislamiento de subprocesos (sin tocar el marco existente):**
  1. se llama con `_run_ffmpeg(cmd, on_progress=…, total_duration=…, stall_timeout, total_timeout)`: **argv en lista, sin shell**, entorno de lista blanca, el hijo muere al cancelar o al vencer el tiempo;
  2. todas las rutas son fijas dentro de `job_dir` (`/work/<id>/`), nunca derivadas del cliente; el `.ass` se escapa con `_escape_for_subtitles_filter` (`:` y `\`) y `fontsdir` es una constante;
  3. el grafo es una **cadena de texto armada solo con enteros y rutas fijas**: ninguna cadena del usuario entra al `filter_complex` (la plantilla elige un archivo, no un fragmento de filtro);
  4. el progreso sigue saliendo de `-progress` con `total_duration` = duración del recorte, y el resultado se sube y `job_dir` se borra en `finally` como hoy;
  5. **topes:** duración máxima de salida (propuesta 10 min en 9:16, configurable; superado → 413 `job_too_large` en el API antes de encolar), un quemado por transcripción, sin red.
- El grafo y sus variantes se construyen en una función pura `build_vertical_cmd(...)` con pruebas de tabla (cada variante, comillas, rutas con espacios y `:`), más una prueba de integración con ffmpeg real que verifica 1080×1920, duración y audio.

## Pilar 3: fuentes OFL (una pesada y una redondeada)

- **Elección (propuesta):** *Montserrat ExtraBold* (pesada, buena lectura en vertical) y *Nunito ExtraBold* (redondeada), ambas SIL OFL 1.1, con soporte latino extendido (español, francés, alemán, portugués, italiano).
  Cobertura de otras escrituras (árabe, CJK, cirílico): cae a `fonts-dejavu-core`/`fonts-noto-core` como respaldo explícito en fontconfig; se documenta como límite.
- **Empaquetado:** los `.ttf` **estáticos** (libass no maneja bien las variables) se versionan en `apps/ai-worker/fonts/` junto a su `OFL.txt` y un `SHA256SUMS`; la CI verifica los hashes. Nada se descarga en el build.
- **Inyección:** `COPY apps/ai-worker/fonts/ /usr/share/fonts/truetype/captionforge/` y `fc-cache -f` en el build (la caché queda en la capa; el contenedor es de solo lectura salvo `/work`, así que no se escribe en tiempo de ejecución).
  Además `ass=…:fontsdir=/usr/share/fonts/truetype/captionforge` fuerza a libass a mirar ahí aunque fontconfig falle, y un `fonts.conf` mínimo (vía `FONTCONFIG_FILE`, ya permitido por la lista blanca) añade el directorio y el respaldo.
- **Verificación en CI:** `fc-match "Montserrat ExtraBold"` y `"Nunito ExtraBold"` devuelven esas familias (no DejaVu); un quemado de prueba falla si stderr de ffmpeg contiene `fontselect: ... using default` o cae a otra familia. El `check_image.py` existente ya valida la imagen: se amplía.
- **Licencia:** `THIRD_PARTY_NOTICES.md` lista cada fuente con su OFL y el binario de ffmpeg con su oferta de fuente (continúa el punto 7 del diseño anterior: frontera de proceso, sin enlazar libav*, BSL intacta).

## Decisiones que necesito del Tech Lead

1. **Fuentes:** ¿Montserrat ExtraBold + Nunito ExtraBold? (alternativas: Poppins ExtraBold / Fredoka).
2. **Tope de duración 9:16:** 10 min por defecto, ¿o más bajo (3 min, típico de Shorts/Reels)?
3. **Calidad de codificado:** `veryfast` + CRF 21 (propuesta) frente a `medium` (≈2× más lento, ≈10 % menos tamaño).
4. **Texto editado:** alineación por `difflib` con respaldo proporcional y marca `approximate` (propuesta).
5. **Un PR:** una sola rama y un PR final con commits por tarea (la parte 1 ya se fusionó), versión **v1.2.0**.

## Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Inyección ASS/filtro desde texto o plantilla | Alto | Escape del texto, plantillas por enum, ninguna cadena de usuario en el `filter_complex`, pruebas hostiles |
| Fuente que no se resuelve y libass usa otra | Medio | `fontsdir` fijo, `fonts.conf`, prueba de CI que lee el stderr de ffmpeg |
| Quemado 9:16 agota RAM o tiempo | Medio | Fondo a 270×480, hilos acotados, tope de duración, un trabajo a la vez, medición en clip real |
| Tiempos por palabra inexactos tras editar | Medio | Política 4 con `approximate` visible; nunca fingir precisión |
| Versiones de libass/ffmpeg difieren entre el ffmpeg de `imageio-ffmpeg` y el de la imagen | Medio | Una sola ruta de binario en el worker, versión fijada y registrada; la prueba de integración corre en la imagen |
| Las palabras `\kf` no coinciden con el texto tras paginar | Medio | Pruebas de propiedades: el texto de las pantallas concatenado = texto del segmento; sin solapes; tiempos monótonos |

## Fuera de alcance (por ahora)

Vista previa de un fotograma en la interfaz, plantillas subidas por el usuario, emoji a color y diarización por color de hablante en el karaoke (candidatos a v1.3).
