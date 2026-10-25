# ADR 0026: temas visuales y vista previa aproximada en CSS

- Estado: aceptado (v1.3.0, iniciativa 3 «Estilos ASS como temas visuales»)
- Relacionado: [ADR 0024](0024-subtitulos-ass-y-formato-vertical.md) (plantillas ASS), [ADR 0025](0025-modo-rapido-y-orquestacion-en-el-cliente.md) (perfiles y preferencias); diseño en `tasks/v1.3.0/plan-phase2.md`

## Contexto

Para elegir cómo se ven los subtítulos quemados había tres desplegables (formato, estilo clásico, plantilla vertical) con nombres como «Impacto (la palabra salta)».
Nadie ve el resultado hasta esperar el quemado. Los parámetros visuales vivían solo en Python: las plantillas en `ass_render.py` y los cuatro estilos clásicos
en `legacy/src/captionforge/ffmpeg_utils.py` (`STYLE_PRESETS`, tamaños relativos a un `PlayResY` de 288 porque ffmpeg convierte el `.srt` a ASS).

## Decisión

1. **Un tema es un nombre amable que se traduce a las opciones de siempre.** Siete temas, uno por motor existente (4 clásicos y 3 plantillas verticales); no hay
   motores de render nuevos. El cuerpo de `POST /v1/jobs/:id/burn` no cambia: un clásico manda `style` y `karaoke`; un vertical, `canvas` y `template`.
2. **Catálogo único en `packages/contracts/themes.v1.json`**, con los datos de mando (`burn`) y de vista previa (`preview`: fuente, modo, proporciones, colores, caja).
   `apps/web/scripts/gen-themes.mjs` lo copia a `themes-data.js` (la interfaz se sirve sin compilar, así que no puede importar el contrato); `web:check` falla si están
   desincronizados. Los colores ASS (`&HAABBGGRR`) se guardan ya como CSS.
3. **La paridad con el motor real se comprueba, no se supone.** `python-tests/test_themes_parity.py` lee `TEMPLATES` y `STYLE_PRESETS` con `ast` (sin importar el worker) y compara
   cada número y color; `test/themes.test.mjs` valida la forma y que cada valor de `style` y `template` del contrato aparece exactamente una vez. Cambiar un color en el motor
   sin actualizar la vista previa rompe la CI.
4. **Vista previa en CSS, con el texto real**, rotulada «Vista aproximada» (libass y el navegador difieren unos píxeles). Funciones puras (`domain/theme-preview.js`) convierten el
   tema en variables CSS y en el estado de cada palabra; `ui/theme-gallery.js` solo las pinta. Tamaño y margen son proporciones de la altura del marco (`cqh`), como en el motor.
   Los estilos se aplican con `style.setProperty`, compatible con la CSP (`style-src 'self'`).
5. **Movimiento prudente.** Solo se anima el tema elegido y solo mientras es visible (`IntersectionObserver`); con `prefers-reduced-motion` queda una foto fija. Las miniaturas de la
   galería son estáticas.
6. **Fuentes de la vista previa**: recortes WOFF al alfabeto latino de Montserrat y Nunito ExtraBold (SIL OFL 1.1, unos 58 KB en total) en `apps/web/public/fonts`, con `SHA256SUMS`
   verificado por una prueba, licencias y el script que las genera. Se piden solo al usar la galería (`@font-face`).
7. **Galería accesible**: `role="radiogroup"` con una sola parada de tabulador, flechas, Inicio y Fin, nombre y descripción por tarjeta. Un tema que no se puede usar (vertical con un video
   mayor que `limits.verticalMaxSeconds`, o una plantilla que el servidor no anuncia) queda desactivado **con el motivo** y la elección vuelve al tema por defecto.
8. **Preferencias v2**: `cf-prefs` sustituye `burnFormat` y `burnTemplate` por `burnTheme`. La v1 se sigue leyendo (formato + plantilla → tema equivalente; lo roto, al tema por defecto) y
   siempre se escribe v2. El formulario de quemado solo lee el tema guardado; no escribe preferencias (para no activar el modo manual de «Control total»).

## Consecuencias

- Elegir estilo es ver el estilo, con tu propio texto, antes de gastar un quemado.
- Añadir un tema es una entrada del catálogo más sus textos (y, si es un motor nuevo, su plantilla en el worker); la prueba de paridad obliga a mantener ambos lados al día.
- La imitación no es exacta. Un fotograma real renderizado por el worker queda para la fase 3.
- Los selectores antiguos desaparecen de la pantalla; sus claves de traducción quedan sin uso hasta una limpieza.

## Alternativas descartadas

- **Miniaturas estáticas**: no muestran tu texto ni el movimiento, y hay que regenerarlas por idioma y lienzo.
- **Mover la fuente de verdad al contrato y generar `TEMPLATES` desde él ya**: más invasivo para el worker; se empieza por la prueba de paridad.
- **Render real de un fotograma por tema**: coste de servidor y espera; fase 3.

## Pruebas

`themes.test.mjs` y `test_themes_parity.py` (contrato y paridad); `themes`, `theme-preview`, `theme-gallery`, `prefs`, `plan`, `quick-mode`, `burn-format` y `fonts` (web);
e2e de navegador: galería con teclado y texto real, vertical desactivado con motivo, migración de preferencias v1 → v2.
