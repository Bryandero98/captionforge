# ADR 0024: subtítulos dinámicos ASS y formato vertical 9:16

- Estado: aceptado (Issue #13, parte 2)
- Relacionado: [ADR 0022](0022-url-base-propia-para-proveedores-de-ia.md) (cierre del TOCTOU), [ADR 0023](0023-audio-puro-como-entrada.md); diseño de partida en `tasks/plan.md`

## Contexto

El quemado de subtítulos producía un video con el formato del original y solo cuatro estilos fijos. Para publicar en Shorts, Reels o TikTok hacen
falta tres cosas: subtítulos que resalten **palabra por palabra** con una tipografía de impacto, un lienzo **vertical 1080×1920** que no recorte
el video original, y fuentes que existan de verdad en el contenedor (la imagen `python:3.12-slim` no trae ninguna y libass cae a otra sin avisar).
Todo debía ejecutarse en un solo pase de ffmpeg, dentro del límite de memoria del contenedor (4 GiB) y sin que ningún texto de la persona
llegue a la línea de comandos ni al grafo de filtros.

## Decisión

1. **Compilador ASS puro** (`ai_worker/ass_render.py`): segmentos → páginas de pocas palabras → archivo `.ass`. No lee disco ni ejecuta nada; se prueba con
   texto de entrada y texto de salida.
   - **Plantillas por enum** (`bold-pop`, `rounded-sweep`, `clean-color`), cerradas en el esquema `burn-job`. La plantilla elige estilos del archivo, nunca un
     fragmento de filtro.
   - **Paginación**: máximo 3 o 4 palabras por pantalla, corte en fin de frase y duración mínima de 0,35 s por página.
   - **Escape**: `{`, `}`, `\` y saltos de línea se neutralizan, de modo que el texto del usuario no puede abrir etiquetas ASS ni eventos nuevos.
   - **Efecto**: barrido (`\kf`), salto de escala (`\t` con `\fscx/\fscy`) o cambio de color, según la plantilla.
2. **Texto editado con difflib.** Los tiempos por palabra solo valen si las palabras guardadas coinciden con el texto actual. Si el texto se editó o se tradujo,
   `difflib.SequenceMatcher` alinea las palabras viejas con las nuevas, conserva los tiempos de las coincidencias y reparte el intervalo restante entre las
   palabras nuevas. Si no hay nada que alinear se reparte proporcionalmente a la longitud. El resultado de esos segmentos se marca **aproximado** y el
   worker informa `approximateSegments` en el resultado, que la interfaz muestra como aviso.
3. **FFmpeg en un solo pase** (`ai_worker/vertical.py`, función pura `build_vertical_cmd`). Una lectura, un codificado:
   `split` → fondo ampliado a cubrir 270×480, `boxblur` y vuelta a 1080×1920 (el desenfoque a baja resolución es unas 16 veces más barato y no se nota) →
   video a 1080 de ancho centrado con `overlay` → `ass=` **al final**, sobre el lienzo ya compuesto, para que las coordenadas del `.ass` sean las de 9:16.
   Una entrada ya vertical (`w/h ≤ 9/16`) omite el fondo y rellena recortando. Los píxeles no cuadrados se corrigen antes del grafo y la rotación del
   contenedor la aplica ffmpeg al decodificar. Codificación `libx264 veryfast`, CRF 21, `yuv420p`, AAC 160 k, `+faststart`, `-filter_threads 2`
   y `-r` igual al de origen con tope de 30. El audio se mapea con `0:a:0?`: un video sin pista no falla.
   El grafo se arma solo con enteros y rutas fijas del trabajo; las rutas se escapan como valores entre comillas. `canvas: "source"` conserva la forma
   original (`build_source_cmd`).
4. **Tope de 10 minutos en 9:16.** El API responde `413 job_too_large` antes de crear nada si el video dura más (la duración sale del resultado de la
   transcripción) y el worker lo recorta además con `-t` (`VERTICAL_MAX_SECONDS`). El quemado normal no tiene ese tope.
5. **Fuentes empaquetadas.** Montserrat ExtraBold (pesada) y Nunito ExtraBold (redondeada), ambas SIL OFL 1.1, como `.ttf` **estáticos** en
   `apps/ai-worker/fonts/` con su licencia y `SHA256SUMS`, que la CI verifica. Nunito se versiona como instancia estática (peso 800) generada con `fontTools`
   porque libass maneja mal las variables. La imagen las instala en `/usr/share/fonts/truetype/captionforge/` y ejecuta `fc-cache`; el filtro pasa además
   `fontsdir=` a esa ruta fija, así que libass las encuentra aunque fontconfig falle. `THIRD_PARTY_NOTICES.md` recoge las licencias.
6. **Contrato.** `burn-job` admite `options.template` y `options.canvas` (`source` | `vertical`), ambos opcionales; `burn-result` añade `approximateSegments`.
   Sin ellos el quemado se comporta exactamente como antes. Un `canvas: "vertical"` sin plantilla usa `bold-pop`.
7. **Interfaz.** Un selector «Formato» (Clásico 16:9 / Vertical Shorts 9:16) muestra de forma progresiva el estilo y el karaoke clásicos o la plantilla vertical.

## Consecuencias

- Las fuentes cubren el latino extendido (español, francés, alemán, portugués, italiano). Otras escrituras (árabe, CJK, cirílico) caen a la fuente de respaldo
  del sistema (DejaVu), con menos diseño pero legibles.
- Con plantilla el resaltado es siempre palabra por palabra, así que `usedKaraoke` es `true`; la precisión se lee en `approximateSegments`.
- Medido sobre un clip sintético de 1080p y 60 s: 36,6 s de codificación y 714 MiB de pico en el proceso de ffmpeg, muy por debajo de los 4 GiB del contenedor.
- Cambiar una fuente exige regenerar `SHA256SUMS`; la CI lo recuerda.

## Alternativas descartadas

- **Dos pasadas** (componer y luego quemar): el doble de codificación y de disco temporal.
- **Desenfocar a 1080×1920**: coste de CPU mucho mayor sin diferencia visible.
- **Fuentes variables o instaladas en el arranque**: libass las trata mal y el contenedor es de solo lectura.
- **Texto libre de plantilla o de fuente en la API**: abriría una inyección en ASS o en el grafo de filtros.

## Pruebas

`test_ass_render.py` (escape hostil, paginación, difflib, tres plantillas), `test_vertical.py` (tablas del comando y ffmpeg real: 1080×1920, audio, tope, resolución
de fuentes sin caer a otra familia), `test_burn.py` (integración con S3 y PostgreSQL reales), contrato con ejemplos válidos e inválidos, `burn.e2e.spec.ts`
(opciones y 413), pruebas del cliente y e2e en navegador, más la comprobación de la imagen (`check_image.py`) en la CI.
