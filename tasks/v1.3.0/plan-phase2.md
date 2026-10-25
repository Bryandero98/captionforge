# v1.3.0, fase 2: temas visuales y editor guiado por problemas

Rama: `feat/v1.3.0-editor-themes` (desde `main` tras fusionar el PR #37). Estado: **borrador de arquitectura para revisión del Tech Lead; no hay código de implementación.**
Parte de [`docs/ROADMAP.md`](../../docs/ROADMAP.md) (iniciativas 3 y 4) y del [plan de la fase 1](plan.md). El CHANGELOG sigue en `[1.3.0] - Sin publicar` y no se etiqueta hasta completar las fases.

Reglas heredadas: rojo → verde, funciones puras antes que DOM, el contrato de la API solo crece de forma compatible, ningún secreto ni dato sensible en el navegador, textos en los 6 idiomas, una suite del API a la vez.

## 0. Lo que ya existe (verificado en el código)

| Pieza | Estado hoy | Consecuencia para el diseño |
|---|---|---|
| Plantillas ASS | `TEMPLATES` en `apps/ai-worker/src/ai_worker/ass_render.py`: `bold-pop`, `rounded-sweep`, `clean-color` (fuente, modo, palabras por pantalla, tamaño y margen relativos, colores, contorno, mayúsculas). Fuentes Montserrat/Nunito ExtraBold (OFL) en `apps/ai-worker/fonts`. | Los números que hacen falta para una vista previa ya existen, pero **solo en Python**. |
| Estilos clásicos | `modern`, `tiktok`, `youtube`, `minimal` son solo identificadores en `burn-options.ts` / `burn-options.js`; su definición visual la usa el worker (`burn.py`). **No he localizado todavía dónde están sus parámetros como datos** (la búsqueda de `tiktok` en `apps/ai-worker/src` no devuelve nada). | Primera tarea de la fase: localizarlos y volverlos datos (ver T-A1). |
| Formulario de quemado | `index.html` (`#burn-form`): selects `burn-format`, `burn-style`, `burn-template`, casilla `burn-karaoke`; `ui/burn.js`. | Es lo que la galería sustituye. El payload hacia `POST /v1/jobs/:id/burn` **no cambia**. |
| Calidad en el API | `apps/api-gateway/src/quality/`: `verifier.ts` (puro; reglas `cps`, `cpl`, `lines`, `duration_min`, `duration_max`, `gap_min`, `overlap`, `invalid_timing`, `balance`; gravedad `error/warning/info`), `fixer.ts` (`proposeFix`: solo tiempos y saltos de línea; lo que exige tocar texto queda en `unfixable`), perfiles `netflix`, `bbc`, `accessible`, `shorts`, `netflix-es`. ADR 0021: **ninguna regla se calcula en el navegador**. | La UI debe seguir consumiendo informes del servidor. |
| Calidad en la UI | `ui/quality.js`: panel aparte con selector de perfil, lista de hasta 50 incidencias, «Proponer arreglo» global y «Aplicar» vía `PUT /segments` con etag. | Funciona, pero está **desconectado del editor**: no marca filas, no navega y mide solo lo **guardado**. |
| Editor | `ui/segment-editor.js` + `domain/editor-state.js`: edita texto y tiempos por índice; **no hay alta, baja, partir ni unir** (el índice de un subtítulo es estable); **no hay deshacer**; `issueOf/issuesOf` son validaciones locales de rango (formato de tiempo, vacío, largo), no calidad. | Los índices del informe siguen alineados con la fila. Hay que añadir deshacer. |
| Onda de audio | El artefacto `waveform` ya se genera y se sirve (`GET …/waveform`), pero **ninguna pantalla lo usa**. | Línea de tiempo con onda es posible sin tocar el worker. |

---

## Iniciativa 3: estilos ASS como «Temas visuales»

### 3.1 Objetivo y principio

Quien termina una transcripción elige **cómo se verán sus subtítulos mirándolos**, no leyendo «Impacto (la palabra salta)» en un desplegable. Un **tema** es un nombre amable que se traduce a las opciones explícitas de siempre (`canvas`, `template` o `style`, `karaoke`). Igual que los perfiles de la fase 1: **tabla del cliente, contrato intacto**.

### 3.2 Catálogo de temas (fuente única de verdad)

`packages/contracts/themes.v1.json` (con esquema y paridad Node/Python como el resto de contratos), con esta forma por tema:

```
id, labelKey, descriptionKey, group ("horizontal" | "vertical"),
burn:    { canvas, template? | style?, karaoke? }          ← lo que viaja al API (igual que hoy)
preview: { font, mode (pop|sweep|color|static), maxWords, sizeRatio, marginRatio,
           primary, secondary, outline, outlineWidth, shadow, upper, popScale }
```

- **Siete temas de salida**, uno por combinación que ya existe (no se inventa motor de render nuevo en esta fase):

| Tema (nombre visible, es) | Grupo | Equivale a hoy |
|---|---|---|
| Minimal profesional | Horizontal 16:9 | estilo `minimal` |
| Clásico YouTube | Horizontal 16:9 | estilo `youtube` |
| Moderno | Horizontal 16:9 | estilo `modern` |
| TikTok en negrita | Horizontal 16:9 | estilo `tiktok` |
| Shorts dinámico | Vertical 9:16 | plantilla `bold-pop` |
| Redondeado suave | Vertical 9:16 | plantilla `rounded-sweep` |
| Limpio de color | Vertical 9:16 | plantilla `clean-color` |

- El worker **deja de tener los números a mano**: `TEMPLATES` se genera (o se verifica en CI) contra el JSON. Camino conservador: **prueba de paridad primero** (Python lee el JSON y compara con `TEMPLATES`), sin mover la fuente de verdad en este PR; migrar el worker al JSON queda como mejora.
- Los perfiles de la fase 1 pasan a apuntar a un tema (`vertical` → Shorts dinámico, `quick-clip` → Moderno) en vez de repetir `canvas/template/style`.
- Preferencias: `cf-prefs` pasa a **v2** con `burnTheme`; lectura de v1 tolerante (`burnFormat`+`burnTemplate` → tema equivalente; lo desconocido, al tema por defecto). Sigue siendo lista blanca.

### 3.3 Vista previa: CSS en el navegador vs miniaturas estáticas

| Criterio | A. Vista previa CSS/DOM con los mismos datos (**recomendada**) | B. Miniaturas estáticas (PNG/SVG) |
|---|---|---|
| Muestra **tu texto** y **tu idioma** | Sí (primer subtítulo real, con tantas palabras como el tema muestre) | No: un texto de muestra fijo, por idioma o en inglés |
| Muestra el **movimiento** (salto, barrido, cambio de color) | Sí, con CSS | No |
| Fidelidad exacta con libass | Aproximada (suavizado, contorno y métricas de fuente difieren unos píxeles) | Exacta **si** se generan con el worker |
| Mantenimiento | Un catálogo de datos; añadir un tema = una entrada | N temas × M idiomas × 2 lienzos de imágenes que regenerar si cambia un color |
| Peso | 2 fuentes woff2 subset (~50–70 KB cada una), carga perezosa al abrir la galería | Imágenes versionadas en el repositorio |
| Riesgo de desincronía | Cubierto con prueba de paridad numérica y revisión visual | Alto: la miniatura puede quedar vieja sin que falle nada |

**Decisión propuesta: A**, rotulada «Vista aproximada», con dos válvulas de escape para la fase 3 (no se hacen ahora): un `POST` que renderiza **un fotograma real** en el worker, y usar un fotograma del video del propio usuario (solo en memoria, en la misma sesión, nunca subido).

Cómo se imita cada modo con CSS (todo en una función pura que devuelve variables CSS a partir de `preview` y la altura del marco):

- Tamaño y margen: `sizeRatio × altura del marco` (unidades de contenedor `cqh`), igual que el worker usa la altura del lienzo.
- Contorno: `paint-order: stroke fill` + `-webkit-text-stroke` (el contorno de ASS va por fuera; el de CSS va centrado, así que se duplica el grosor) y `text-shadow` para la sombra.
- `pop`: la palabra activa escala `popScale %` con una animación corta y se asienta. `sweep`: relleno que avanza con `background-clip: text`. `color`: la palabra activa cambia de `secondary` a `primary`.
- Ciclo: una palabra cada ~450 ms, solo en el tema **seleccionado** y solo si es visible (`IntersectionObserver`); las demás tarjetas muestran el primer cuadro estático (cuesta casi nada). Con `prefers-reduced-motion`, todo queda estático con la palabra activa resaltada.
- Fondo del marco: dos tonos neutros con la proporción del lienzo (16:9 o 9:16). Las fuentes se sirven desde `apps/web/public/fonts` con los mismos `.ttf` OFL y un `SHA256SUMS` verificado en la CI (como en el worker).

### 3.4 Experiencia (UX)

1. En el panel de resultado, «Poner los subtítulos en el video» muestra un **marco grande** con el tema elegido (y tu primer subtítulo) y debajo una **galería** en dos grupos, *Horizontal 16:9* y *Vertical 9:16*.
2. La galería es un `role="radiogroup"` con una sola parada de tabulador (tabindex itinerante), flechas para moverse, Espacio/Enter para elegir; cada tarjeta tiene nombre y descripción corta accesibles; el marco es decorativo y se acompaña de un texto equivalente («Vista aproximada: letras amarillas en mayúsculas, la palabra activa salta»).
3. Los selects `burn-format`, `burn-style` y `burn-template` desaparecen del flujo normal. La casilla de karaoke solo aparece en temas horizontales. El aviso del tope vertical (600 s por defecto, de `capabilities`) se reutiliza: un tema vertical se **desactiva con motivo** si el video lo supera.
4. «Control total» del Modo Rápido usa un `<select>` compacto con los mismos nombres de tema (sin vista previa) para no duplicar la galería.
5. Sin JavaScript de galería (fallo de carga de fuentes o de estilos), el formulario degrada a un `<select>` de temas: mismo catálogo, misma petición.

### 3.5 Módulos y pruebas

| Módulo | Contenido | Pruebas (primero) |
|---|---|---|
| `packages/contracts/themes.v1.json` + esquema | Catálogo | Esquema válido; todos los `burn.*` existen en `burn-job.v1.json`; paridad con `TEMPLATES` de Python |
| `domain/themes.js` | `THEMES`, `themeById`, `themeToBurnOptions`, `themeForLegacy(format, template, style)`, `availableThemes(caps, durationSeconds)` | Cada tema produce exactamente el payload actual; tema vertical no disponible si la duración supera el tope; migración v1 → v2 |
| `domain/theme-preview.js` | Función pura `previewStyle(theme, frame)` → variables CSS y plan de animación | Tabla de entradas/salidas por modo; ratios; `upper`; sin tema, valores seguros |
| `ui/theme-gallery.js` | Radiogroup, marco, ciclo de palabras, `IntersectionObserver`, movimiento reducido | DOM falso: teclado, selección, desactivado con motivo, limpieza de temporizadores |
| `ui/burn.js` | Lee el tema en vez de tres selects | Las pruebas actuales del quemado siguen verdes con el mismo payload |
| i18n ×6 | Nombres y descripciones de 7 temas, grupos, «Vista aproximada», motivos | Paridad de claves y marcadores |
| e2e (puppeteer) | Elegir tema con teclado → `burn.options` en la base de datos coinciden; tema vertical bloqueado con motivo; captura de la vista previa estable | — |

---

## Iniciativa 4: editor guiado por problemas

### 4.1 Objetivo y principio

Pasar de «aquí tienes un informe» a **«estos son los 5 sitios donde mirar, y con un clic quedan arreglados»**, sin mover una sola regla al navegador (ADR 0021) y sin tocar el texto salvo los saltos de línea (ADR 0021, punto 5).

### 4.2 Problema técnico central: medir lo que se está editando

Hoy `GET /v1/jobs/:id/quality` mide la versión **guardada**. Un editor guiado necesita medir lo **no guardado** mientras se escribe. Tres caminos:

| Opción | Cómo | Veredicto |
|---|---|---|
| A. **Endpoint sin estado** `POST /v1/jobs/:id/quality/check` con `{ profile, segments }` | Mismo `checkQuality`/`proposeFix` puros; no lee el almacenamiento; mismo permiso y aislamiento por trabajo que ver segmentos | **Recomendada**: reglas siguen solo en el API; coste de CPU mínimo; se puede acotar y limitar |
| B. Guardar antes de medir | Reutiliza el `GET` | Obliga a guardar a cada pulsación o a medir con retraso; inaceptable |
| C. Portar las reglas a JS | Medición local instantánea | **Descartada**: duplica lógica y rompe ADR 0021 |

Detalles de A: cuerpo con tope (mismo máximo de subtítulos y de tamaño que `PUT /segments`; 413/400 con los códigos de siempre), límite de frecuencia propio, `fps` opcional, respuesta = informe + `fixes` por subtítulo. La interfaz **solo envía lo mínimo** (`start`, `end`, `text` por índice), con debounce de ~600 ms, `AbortController` y número de secuencia para descartar respuestas viejas. No se envía si las validaciones locales de rango fallan (ya existen en `editor-state`).

**Arreglo de un clic.** `proposeFix` hoy es global; se agrupa **por subtítulo** (`fixes[index] = { rules, edit: { start?, end?, text? }, summary }`). Aplicar un arreglo escribe ese `edit` en el estado local del editor (no guarda), se mide de nuevo y las incidencias vecinas se actualizan, porque un arreglo de tiempo puede cambiar el hueco con el siguiente. «Arreglar todo lo arreglable» sigue siendo el flujo actual, ahora local y deshacible.

### 4.3 Estado y vista (funciones puras)

- `domain/quality-view.js`: de `report.issues` a una estructura lista para pintar y navegar: `byRule` (conteos por regla), `bySegment` (peor gravedad e incidencias de cada fila), `ordered` (gravedad, luego tiempo), `next(index)` / `previous(index)`. Sin reglas dentro: solo agrupa lo que dijo el servidor.
- `domain/quality-summary.js`: frases con plural por regla («3 subtítulos demasiado rápidos», «1 solapamiento»), de claves i18n `quality.rule.<regla>.one/other`, con el límite y lo medido (`17 car/s, máximo 15`).
- `domain/editor-state.js` gana **historial de deshacer** (pila acotada de instantáneas de borradores) para que cualquier arreglo sea reversible; hoy no existe.
- Perfil por defecto: `shorts` si el tema o el perfil de la fase 1 es vertical; `netflix-es` / `netflix` según el idioma si no (lógica ya presente en `quality.js`).

### 4.4 Experiencia (UX)

1. **Cabecera del editor (sticky)**: nota de calidad («92 %») y **chips por regla** con su conteo («3 demasiado rápidos», «1 solapamiento»). Un chip filtra la lista y salta al primero; «Siguiente problema» / «Anterior» con botones y atajos documentados.
2. **Marcas en las filas**: borde y **icono con palabra** (Error / Aviso / Info) —nunca solo color—, explicación en una línea bajo el campo afectado y, si hay arreglo, el botón **«Arreglar: terminar 0,4 s antes»** (texto concreto de lo que hará). Lo no arreglable muestra la sugerencia («Divide este subtítulo») y enfoca el campo de texto.
3. **Línea de tiempo (minimapa)** sobre la lista: bloques proporcionales al tiempo para cada subtítulo, con marcas de gravedad; clic o teclado lleva a la fila y, si hay audio, mueve el reproductor. Es una **lista de botones real** (`role="list"`) pintada como franja: la canvas, si se usa para la onda, es decorativa. Con muchos subtítulos se agrupan en intervalos para que cada marca sea clicable (mínimo 24 px). **Onda de audio opcional** (`waveform` ya existe) como mejora de esta misma fase si el tamaño del artefacto lo permite; si no, se difiere.
4. **Acciones**: arreglar uno, «Arreglar todos de este tipo», «Ignorar» (solo en la sesión), **Deshacer** (toast con anuncio) y «Guardar» sin cambios respecto a hoy (`PUT /segments` con etag; 409 pide revisar).
5. **Accesibilidad**: región `aria-live="polite"` que anuncia «Quedan 2 problemas» con anti-ráfagas; tras arreglar, el foco pasa al siguiente problema o al campo corregido; el estado «midiendo…» se dice con texto; todo funciona con teclado.
6. **Convivencia con «Sube y olvídate»**: el encadenado de la fase 1 crea el video al terminar la transcripción, **antes** de que nadie revise. Propuesta: no bloquearlo; el resultado muestra una insignia «Calidad 92 % · 3 avisos» con «Revisar», y re-quemar sigue siendo un clic tras corregir. Decisión del Tech Lead abajo.

### 4.5 Módulos y pruebas

| Módulo | Contenido | Pruebas (primero) |
|---|---|---|
| API `quality.controller.ts` / `quality.service.ts` | `POST …/quality/check` (informe + `fixes` por subtítulo) | Rojo/verde: informe igual al `GET` con los mismos datos; topes 400/413; sin permiso 404; límite de frecuencia; no lee almacenamiento; arreglo por subtítulo coincide con `proposeFix` |
| `packages/contracts` (si se versiona) | Esquema de petición/respuesta | Ejemplos válidos e inválidos |
| `api/jobs.js` | `checkQuality({ jobId, profile, segments, signal })` con validación estricta de la forma | Respuesta rara → `bad_response`; cancelación; secuencia |
| `domain/quality-view.js`, `domain/quality-summary.js` | Agrupación, orden, navegación, plurales | Tablas por regla y gravedad; navegación circular; 0 incidencias |
| `domain/editor-state.js` | Deshacer / rehacer, aplicar `edit` | Ida y vuelta; pila acotada; no marca como sucio lo igual al original |
| `ui/guided-editor.js` (cabecera, marcas, minimapa) | Pintado y teclado | DOM falso: chips filtran, siguiente/anterior, foco tras arreglar, anuncio sin ráfagas |
| `ui/quality.js` | Se integra con el editor (el panel aparte se pliega o se absorbe) | Pruebas actuales siguen verdes o se migran con la misma cobertura |
| i18n ×6 | Reglas en singular/plural, acciones, estados | Paridad |
| e2e (puppeteer) | Editar → aparece incidencia sin guardar → «Arreglar» → desaparece → Deshacer la devuelve → Guardar con etag; teclado | — |

---

## Orden de trabajo propuesto

| Tarea | Qué | Depende de | Tamaño |
|---|---|---|---|
| A1 | Localizar los parámetros de los 4 estilos clásicos y llevarlos a datos; `themes.v1.json` + esquema + paridad con `TEMPLATES` | — | M |
| A2 | `domain/themes.js` + migración de preferencias a v2 + perfiles apuntan a temas | A1 | M |
| A3 | `domain/theme-preview.js` + fuentes web con hash en CI | A1 | M |
| A4 | `ui/theme-gallery.js` y sustitución de los selects del quemado (con degradación) | A2, A3 | L |
| B1 | API: `POST …/quality/check` + arreglo por subtítulo (rojo/verde) | — | L |
| B2 | `api/jobs.js` + `domain/quality-view.js` + `quality-summary.js` + deshacer en `editor-state.js` | B1 | L |
| B3 | `ui/guided-editor.js`: cabecera, marcas por fila, acciones, anuncios | B2 | L |
| B4 | Minimapa (y onda si procede) | B3 | M |
| C | i18n ×6, e2e de ambas iniciativas, ADR 0026 (temas) y ADR 0027 (editor guiado), CHANGELOG `[1.3.0]`, guías | todas | M |

Checkpoints: tras A1–A3 y B1 (datos y API, sin tocar pantalla); tras A4; tras B3–B4; cierre. A y B son independientes, así que pueden ir en paralelo o en PR separados.

## Riesgos y mitigaciones (pre-mortem corto)

| Riesgo | Impacto | Mitigación |
|---|---|---|
| La vista CSS no coincide con el vídeo real y la persona se decepciona | Medio | Rótulo «Vista aproximada», paridad numérica en CI, mismas fuentes, y fotograma real en la fase 3 |
| Fuentes web aumentan el peso inicial | Bajo | Carga perezosa al abrir la galería, woff2 subset latino, `font-display: swap` |
| El `POST …/quality/check` se usa para saturar el API | Medio | Tope de cuerpo y de subtítulos, límite de frecuencia por usuario, debounce y cancelación en el cliente |
| Un arreglo de tiempo crea un problema en el vecino | Medio | Remedir tras cada arreglo, deshacer siempre disponible, el servidor calcula el arreglo con el contexto completo |
| El minimapa se vuelve inmanejable con miles de subtítulos | Medio | Agrupar por intervalos, marcas mínimas de 24 px, lista accesible aparte |
| Migrar preferencias v1 → v2 rompe a quien ya tiene ajustes | Bajo | Lectura tolerante, valor por defecto ante lo desconocido, prueba de migración |
| El encadenado crea un video con subtítulos sin revisar | Medio | Insignia de calidad + re-quemado de un clic; decisión abajo |

## Decisiones que necesito del Tech Lead

1. **Vista previa:** ¿CSS/DOM con los datos del catálogo (recomendado) o miniaturas estáticas? ¿Aceptamos «Vista aproximada» y dejamos el fotograma real para la fase 3?
2. **Calidad en vivo:** ¿aprobamos el endpoint sin estado `POST …/quality/check` (recomendado) como extensión compatible del contrato del API?
3. **Siete temas = los motores actuales**, sin estilos nuevos de render en esta fase. ¿De acuerdo, y con los nombres propuestos?
4. **Encadenado vs revisión:** ¿insignia de calidad sin bloquear (recomendado) o una opción «Revisar antes de crear el video»?
5. **Onda de audio** en el minimapa: ¿entra en esta fase si el tamaño del artefacto es razonable, o se difiere?
6. **PRs:** ¿uno por iniciativa (A y B por separado, recomendado) o uno solo para la fase 2?
