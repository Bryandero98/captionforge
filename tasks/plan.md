# Plan de implementación: Issue #13 (v1.1), control de calidad de subtítulos y subtítulos dinámicos ASS

Rama: `feat/issue-13-quality-and-styles` (local, desde `main` en la v1.0.0). Estado: **borrador para revisión técnica, sin código ni migraciones**.
Tareas en [todo.md](todo.md). ADR previstos: 0021 (calidad) y 0022 (estilos dinámicos y licencias). El plan del #11 quedó en `tasks/archivo/issue-11/`.

## Resumen

Dos funciones que trabajan sobre una transcripción terminada y no cuestan nada por uso (todo local):

- **Control de calidad (QA):** mide cada subtítulo contra un perfil (Netflix, BBC, accesible, cortos verticales) y dice qué incumple y por cuánto. Un
  «arreglar» opcional corrige solo tiempos y saltos de línea, nunca el texto.
- **Subtítulos dinámicos (estilo TikTok/Shorts):** plantillas que resaltan la palabra que se dice, con pocas palabras por pantalla y formato 9:16, quemados
  con el ffmpeg que ya usamos.

## Hechos del código que condicionan el diseño (verificados)

| Hecho | Consecuencia |
|---|---|
| `transcribe.py` ya pide `word_timestamps=True` y cada segmento guarda `words` | No hace falta cambiar el modelo: hay que **exponer** los tiempos por palabra, no extraerlos de nuevo |
| `burn.py` ya genera ASS con karaoke (`segments_to_ass`, `\k`) cuando algún segmento conserva `words`, y informa `usedKaraoke` | Las plantillas se montan sobre ese camino; el karaoke básico ya existe |
| Traducir o editar el texto **descarta** `words` | Con texto editado no hay tiempos por palabra: se necesita una política (decisión 4) |
| `segments.json` es un artefacto sin esquema en `packages/contracts`; `burn-job` solo tiene `style` y `karaoke` | Los contratos crecen de forma aditiva (campos opcionales, `schemaVersion` 1) |
| El quemado es un trabajo hijo con `parentJobId`, 409 si ya hay uno y ETag de segmentos | Se reutiliza para plantillas y 9:16; no se crea un tipo de trabajo nuevo |
| El ffmpeg viene de `imageio-ffmpeg` (con libass) y se invoca como **subproceso** con tiempos límite | Es lo que mantiene la licencia limpia (decisión 7) |
| Las fuentes de la imagen son las que libass puede dibujar (fontconfig) | Las plantillas solo pueden nombrar fuentes que la imagen trae |

## Decisiones de arquitectura

### 1. Perfiles de QA (CPS, CPL, solapes)
Los perfiles son **datos**, no código: `packages/contracts/quality-profiles/*.v1.json`, validados por JSON Schema (misma regla del ADR 0001).

| Regla | Qué mide | Gravedad |
|---|---|---|
| `cps` | caracteres por segundo (con espacios; sin etiquetas) | aviso por encima del límite, error por encima de límite + 3 |
| `cpl` | caracteres por línea | error |
| `lines` | líneas por subtítulo | error |
| `duration_min` / `duration_max` | duración mínima y máxima | aviso |
| `gap_min` | separación mínima entre subtítulos (ms; depende de los fotogramas por segundo del perfil) | aviso |
| `overlap` | un subtítulo empieza antes de que acabe el anterior | error |
| `balance` | diferencia de largo entre líneas (pirámide) | información |

Perfiles iniciales: `netflix` (CPL 42, 2 líneas, CPS 17, 5/6 s a 7 s), `bbc` (CPL 37, CPS ~ 160 palabras por minuto), `accessible` (CPS bajo, 2 líneas, duración mínima
más larga) y `shorts` (CPL ~ 20, 1–2 líneas, pensado para 9:16). Los números exactos se confirman contra las guías públicas antes de fijarlos (tarea T1).

El verificador es una **función pura** (`segments + perfil → incidencias`), en el API (TypeScript), sin base de datos ni red. Contrato de salida:
`{ profile, summary: {errors, warnings, score}, issues: [{segment, rule, severity, measured, limit}] }`. Se expone como `GET /v1/jobs/:id/quality?profile=`
(solo lectura, mismo permiso que ver segmentos). La interfaz **no reimplementa** las reglas: pide el informe y pinta las marcas por subtítulo, así no hay
dos verificadores que se desvíen.

**Arreglar** es una *propuesta* (`POST …/quality/fix` devuelve segmentos nuevos sin guardarlos) que el usuario aplica con el flujo de edición existente (ETag).
Solo toca tiempos (alargar el final hacia el hueco libre, separar solapes) y saltos de línea; **invariante: el texto, quitando saltos, es idéntico**. Se prueba con
pruebas de propiedades (el texto no cambia, nunca crea un solape, es idempotente).

### 2. Tiempos por palabra: extraer y exponer
- No se extraen otra vez: ya salen de faster-whisper. Se formaliza `Segment` y `Word` (`start`, `end`, `text`, `probability`) en `packages/contracts` como campos
  opcionales y se generan los tipos TS y Python.
- `GET /v1/jobs/:id/segments` devuelve `words` cuando existen (hoy el worker los guarda; hay que comprobar qué filtra el API). Se valida el tamaño (tope de
  segmentos del ADR 0020 ya aplica) y se comprime con gzip.
- El karaoke exige palabras ordenadas, dentro del segmento y sin solape: un normalizador las repara o las descarta, y el quemado informa `usedKaraoke`.

### 3. Plantillas ASS
- Una plantilla es un **JSON validado** (lista blanca): fuente (de las instaladas), tamaño relativo a la altura, colores `#RRGGBB`, contorno, sombra, alineación,
  márgenes, palabras máximas por pantalla (1–4), modo de resalte (`sweep` con `\kf`, `pop` con evento por palabra y `\t` de escala, `color`), mayúsculas.
- El texto **nunca** va crudo al ASS: se escapan `{`, `}` y `\` y se normalizan los saltos, para que nadie inyecte etiquetas de override desde el texto del subtítulo.
- Plantillas de fábrica en el repositorio (3 a 5) más la posibilidad de elegirlas en el quemado: `burn-job` gana `template` y `canvas` opcionales; sin ellos, el
  comportamiento actual no cambia (compatibilidad).
- **Formato vertical 9:16** (1080×1920): por defecto, el video original centrado sobre un fondo desenfocado de sí mismo (no pierde contenido), con alternativa de
  recorte central. Lo hace un solo grafo de filtros de ffmpeg junto con `ass=`. La interfaz avisa de que reencodear cuesta tiempo y fija topes de duración.
- Un subtítulo con muchas palabras se parte en pantallas de N palabras repartiendo el tiempo según los tiempos reales, no por igual.

### 4. Política cuando el texto se editó (sin tiempos por palabra)
Opciones: (a) sin resalte, subtítulo completo (hoy); (b) alinear a nivel de palabra con las palabras originales (difflib) y conservar tiempos de las que
coinciden; (c) repartir el tiempo del subtítulo proporcionalmente al largo de cada palabra. **Propuesta:** (b) con respaldo a (c) y una marca
`approximate` que la interfaz muestra; nunca fingir precisión.

### 5. Dónde corre cada cosa
QA: API (instantáneo, sin hueco de ejecución del worker). Plantillas y 9:16: worker Python (reutiliza `burn.py`, un hueco de ejecución, tiempos límite
de ffmpeg ya existentes). RAM: igual que el quemado actual; el filtro de desenfoque se limita a escalas pequeñas.

### 6. Interfaz (sin build, módulos ES)
Panel «Calidad» (selector de perfil, resumen, marcas por subtítulo, botón «Proponer arreglo» con vista de diferencias) y, en «Quemar», selector de plantilla y de
formato con vista previa de un fotograma. 6 idiomas, accesible (las marcas no dependen solo del color), pruebas web + e2e de navegador.

### 7. Licencia BSL y ffmpeg (GPL): cómo no contaminarla
1. **Frontera de proceso:** CaptionForge solo ejecuta `ffmpeg` como programa aparte con argumentos (lo que ya hace). No se enlaza ninguna biblioteca de FFmpeg
   (no PyAV, no `libav*` por FFI, no bindings que carguen `libass` en proceso). Se prueba en CI: lista de dependencias prohibidas y revisión del lockfile.
2. **Agregación, no obra derivada:** el binario viaja en la imagen junto a nuestro código, comunicándose solo por línea de comandos y archivos. El código de CaptionForge sigue bajo BSL.
3. **Obligaciones del binario:** el ffmpeg de `imageio-ffmpeg` es una compilación estática que puede incluir componentes GPL (libx264). Al distribuir la imagen se cumplen
   las obligaciones de ese binario: aviso de licencia, versión fijada y **oferta de código fuente** (o enlace a la fuente exacta) en `THIRD_PARTY_NOTICES.md`.
   Alternativa si se quiere reducir exposición: `ffmpeg` del sistema con codificador permisivo; se evalúa en el ADR 0022.
4. **Fuentes:** solo con licencia que permita redistribuir (OFL/Apache); se listan con su licencia en los avisos.
5. **Texto de usuario:** no se mezcla con código ASS sin escapar (ver 3), lo que también cierra la vía de ejecutar opciones de ffmpeg desde el contenido.
Nota: es una decisión de ingeniería para reducir riesgo, no asesoría legal; el encuadre de GPL/BSL conviene validarlo con un abogado antes de comercializar.

## Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Umbrales de perfil mal copiados de una guía | Medio | Fuente citada por perfil en el JSON; los números se verifican en T1; tests de tabla |
| El arreglo cambia el sentido de un subtítulo | Alto | Invariante de texto con pruebas de propiedades; es propuesta, no se guarda sola |
| Tiempos por palabra inexactos tras editar | Medio | Política 4 con marca `approximate` |
| Quemar en 9:16 agota RAM o tiempo | Medio | Tope de duración, un hueco de ejecución, filtros acotados, tiempos límite existentes |
| Inyección ASS o de filtros ffmpeg desde el texto o el nombre de plantilla | Alto | Lista blanca, escape del texto, rutas fijas, pruebas con cargas hostiles |
| Fuente que falta y libass cae a otra | Bajo | Se prueba que cada plantilla resuelve su fuente en la imagen (CI) |
| Alcance: dos funciones en un PR | Medio | Dos fases con punto de control; si QA se alarga, se divide en dos PR (decisión del Tech Lead) |

## Decisiones pendientes para el Tech Lead
1. ¿El verificador vive solo en el API (propuesta) o también como módulo compartido para validar en vivo en el navegador?
2. Formato 9:16 por defecto: fondo desenfocado (propuesta) o recorte central.
3. Fuentes a incluir (propuesta: 2 OFL de buena lectura en pantalla vertical, p. ej. una sans negrita y una redondeada).
4. Política de texto editado: (b)+(c) como arriba.
5. ¿Un PR único con commits por tarea (como el #11) o dos PR (QA y estilos)?
6. ¿Perfil `shorts` entra en esta versión?
