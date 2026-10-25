# Plan de la v1.3.0, fase 1: «Sube y olvídate» y «Resultado rápido / Control total»

Rama: `feat/v1.3.0-ux-onboarding` (desde `main` en v1.2.0). Hoja de ruta: [`docs/ROADMAP.md`](../../docs/ROADMAP.md).
Alcance de este documento: **solo las iniciativas 1 y 2**, arquitectura del cliente (JS vainilla con módulos ES, sin build) y ajustes mínimos de la API.
Reglas: rojo → verde, una suite del API a la vez, commits por tarea, PR único solo cuando lo ordene el Tech Lead. Estado: **decisiones aprobadas por el Tech Lead (ver §0); T1–T6 hechas hasta el Checkpoint 2; la interfaz (T7–T11) espera su luz verde.**

## 0. Decisiones aprobadas

1. **Encadenado en el cliente** en la fase 1 (D4); el servidor lo asumirá en la fase 3.
2. **Hablantes**: solo Podcast y Reunión, menos de 60 min, si el servidor los ofrece, siempre visibles en el resumen.
3. **Modo**: la interfaz **siempre abre en Resultado rápido**; «Control total» se abre a mano cada vez. Por eso `mode` no está en las preferencias.
4. **Nombres de perfil**: «Vertical (Shorts/Reels)», «Podcast», «Reunión», «Clip rápido», «Estándar» (ids `vertical`, `podcast`, `meeting`, `quick-clip`, `standard`).
5. Dependabot se ignora; la rama BYOK quedó respaldada en `archive/byok-adapters-wip` (con la clave de prueba con forma real sustituida por una armada en ejecución, porque la protección de secretos del repositorio bloqueaba el push).

## 1. Punto de partida (verificado en el código)

| Hecho | Consecuencia |
|---|---|
| `index.html` muestra siempre 5 controles juntos (modelo, idioma, traducir a, limpiar audio, hablantes) antes del botón `#start`; `app.js` los lee por `id` y arma `options` en un solo sitio (`app.js:205`) | La separación se puede hacer **moviendo** los controles a un `<details>` sin cambiar sus `id`: `app.js` no se entera |
| El navegador conoce de un archivo local: `name`, `size`, `type`, y con un elemento `<video>`/`<audio>` en `preload="metadata"` su **duración** y **dimensiones**, sin subirlo | El análisis de intención es 100 % cliente y no cuesta ancho de banda |
| El servidor solo conoce la duración **después** de transcribir (`result.durationSeconds`); el tope de 10 min del 9:16 se descubre hoy con un 413 tras esperar | Hay que publicar el tope en `GET /v1/capabilities` para avisar **antes** de subir |
| `GET /v1/capabilities` ya es la vía de mejora progresiva (diarización, BYOK); si falla, todo se apaga | Es el sitio natural para los límites nuevos |
| `localStorage` ya se usa (`cf-api-key`, `captionforge_lang`, historial) siempre con `try/catch` | Mismo patrón para las preferencias |
| Se suben varios archivos en cola (`domain/batch.js`, hasta 20), cada uno crea su trabajo | El perfil se calcula **por archivo**; el resumen debe soportar lotes mixtos |
| El quemado es un trabajo aparte que ya se pide con `POST /v1/jobs/:id/burn` | «Sube y olvídate» puede encadenarlo sin tocar el worker |

## 2. Decisiones de arquitectura

| # | Decisión | Motivo / alternativa descartada |
|---|---|---|
| D1 | **Un perfil no es un concepto del servidor.** Es una tabla del cliente que se traduce a las opciones explícitas de siempre (`modelSize`, `cleanAudio`, `diarize`…) y, si procede, a las de `burn` (`canvas`, `template`). El contrato de `POST /v1/jobs/transcribe` **no cambia**. | Servidor sin estado nuevo, nada que migrar, ninguna intención del usuario viaja ni se guarda. Descartado: campo `profile` en la API (acopla versiones y filtra intención). |
| D2 | **La detección es una función pura** `analyze(facts, caps) → { profileId, reasons[] }` sobre una tabla ordenada de reglas; el primero que casa gana, y siempre hay un perfil de respaldo equivalente a los valores de hoy. | Se prueba con tablas; fácil de explicar y de cambiar. Descartado: heurísticas por nombre de archivo (frágiles, exigen i18n por palabra clave, falsos positivos); queda fuera de la fase 1. |
| D3 | **Extraer los hechos con metadatos locales** (`probeMedia`), con tiempo máximo de 4 s y degradación: si no se puede leer (MKV/AVI en algunos navegadores), los campos son `null` y se cae al perfil Estándar con el motivo «no se pudo leer la duración». Nunca bloquea la subida. | Sin `ffprobe` en el cliente ni subidas anticipadas. |
| D4 | **«Sube y olvídate» en la fase 1 es orquestación del cliente**: al completarse la transcripción, el cliente pide el quemado con `startBurn`. La interfaz lo dice sin ambigüedad («mantén esta pestaña abierta; si la cierras, el video lo creas tú desde Recientes»). | Encadenar en el servidor exige un gancho de finalización (QueueEvents o NOTIFY de PostgreSQL) que es justo la infraestructura de la iniciativa 5. Se deja el hueco: el mismo `followUp` se moverá al servidor en la fase 3 sin cambiar la interfaz. |
| D5 | **Solo se encadena lo barato y local**: el quemado. Traducir, doblar, claves propias y limpieza de voz **nunca** se activan solos; pueden aparecer como sugerencia que la persona acepta. | Evita gasto o tiempos inesperados; coherente con las decisiones de 1.1 sobre BYOK. |
| D6 | **Dos modos, un solo formulario.** «Resultado rápido» es el estado por defecto del mismo `<form id="upload-form">`; «Control total» es un `<details id="advanced">` dentro de él con los controles existentes y los nuevos. Sin rutas ni páginas nuevas. | Menos código, foco y teclado nativos, mejora progresiva si falla el JS (el `<details>` abierto por defecto sin JS). |
| D7 | **Las preferencias son una lista blanca de enums y booleanos**, versionadas (`v:1`), con lectura estricta que descarta lo desconocido. Jamás se guardan claves, URL base, modelos de BYOK, nombres de archivo ni duraciones. | Un `localStorage` manipulado no puede inyectar valores fuera de contrato. |
| D8 | **El servidor publica sus límites**: `GET /v1/capabilities` añade `limits.verticalMaxSeconds` y `burn.templates`. La constante `VERTICAL_MAX_SECONDS` del API pasa a configuración compartida con el worker (hoy son dos valores que podrían divergir). | Aviso antes de subir en vez de 413 después; una sola fuente del tope. |

## 3. Cliente: módulos nuevos (`apps/web/public/js/`)

```
domain/
  media-probe.js    probeMedia(file, env) → { kind, durationSeconds|null, width|null, height|null }
  profiles.js       tabla PROFILES y toUploadOptions(profile, caps) / toFollowUp(profile, facts, caps)
  intent.js         analyze(facts, caps) → { profileId, reasons: string[] }   (pura)
  prefs.js          defaultPrefs, parsePrefs(raw), serializePrefs(p), applyPrefs(p, caps)   (pura)
ui/
  quick-mode.js     createQuickMode({ doc, win, t, caps, storage, onChange }) → controlador del formulario
  follow-up.js      createFollowUp({ startBurn, follow, t, announce }) → encadena el quemado al completar
```

`app.js` conserva el envío y el seguimiento. Cambia solo en dos puntos: pide `quickMode.optionsFor(file)` en lugar de leer los selectores directamente, y registra el `followUp` del trabajo recién creado.

### 3.1 Análisis de intención (iniciativa 1)

**Hechos** (`facts`), todos locales: `kind` (`audio`|`video`, por MIME/extensión con `domain/media.js`), `durationSeconds`, `width`, `height`, `sizeBytes`.
`probeMedia(file, kind, env)` crea un `<video>`/`<audio>` fuera del DOM con `preload="metadata"` y un `URL.createObjectURL(file)` que **siempre se revoca** (en `loadedmetadata`, `error` y tiempo agotado). No se decodifica ni se carga el archivo entero, así que un archivo de 4 GiB cuesta lo mismo que uno de 4 MiB.

**Reglas** (en orden; el primer acierto gana; cada una devuelve su motivo traducible):

| Perfil | Condición | Opciones que fija | Encadenado |
|---|---|---|---|
| `vertical` | video, vertical (`h ≥ 16/9·w` aprox.) y `duración ≤ verticalMaxSeconds` | `modelSize: small` | quemado `canvas: vertical`, plantilla `bold-pop` |
| `podcast` | audio de 5 min en adelante | `modelSize: small`, `diarize` solo si el servidor lo ofrece y `duración ≤ 60 min` | ninguno (un audio no se quema) |
| `meeting` | video horizontal de 20 min en adelante | `modelSize: small`, `diarize` si está disponible y `duración ≤ 60 min` | ninguno |
| `quick-clip` | video horizontal de menos de 3 min | `modelSize: small` | quemado clásico, estilo `modern` |
| `standard` (respaldo) | cualquier otro caso, incluida duración desconocida | los valores de hoy | ninguno |

`sourceLanguage` y `translateTo` **nunca** se infieren: autodetectar y sin traducir. Los umbrales viven en una constante exportada y se ajustan en un solo sitio.
Una sugerencia aplicada por regla se marca `source: "auto"`; en cuanto la persona toca un control avanzado pasa a `source: "manual"` y deja de reescribirse sola (solo se ofrece como chip).

**Lotes.** Cada archivo del lote lleva su propio resultado de `analyze`. Si la persona no tocó nada, cada trabajo se crea con las opciones de su perfil; el resumen agrupa («3 archivos: 2 Short vertical, 1 Podcast»). Si hizo cualquier ajuste manual, ese ajuste se aplica a todo el lote y el encadenado queda apagado salvo que lo active ella.

### 3.2 Separación de la interfaz (iniciativa 2)

```
<form id="upload-form">
  <fieldset id="form-fields">
    zona de arrastre / lista del lote            (sin cambios)
    <section id="quick" aria-live="polite">      NUEVO
      <p id="quick-summary">   «Se generarán subtítulos con detección automática de idioma.»
      <p id="quick-suggestion" hidden>  chip: «Sugerido: Short vertical · Es vertical y dura 48 s»  [Cambiar]
      <button type="submit" id="start" class="btn--hero">Generar subtítulos</button>   gigante, ancho completo
    </section>
    <details id="advanced">  <summary>Control total</summary>
      selector «Perfil» (Automático + cada perfil)   NUEVO
      modelo · idioma · traducir a · limpiar audio · hablantes      (los controles actuales, mismos id)
      formato de quemado + plantilla · «Crear también el video al terminar»   NUEVO
      «Restablecer preferencias»                      NUEVO
    </details>
  </fieldset>
</form>
```

- **Valores seguros por defecto** (los de hoy): `small`, autodetectar, sin traducción, sin limpieza, sin hablantes, sin encadenado. Un usuario que nunca abre «Control total» obtiene exactamente lo que obtiene hoy, con una pulsación.
- **El botón sigue siendo `#start`** (mismo `id`, mismo `type=submit`): ninguna prueba ni flujo existente se rompe. Pasa a ser el control dominante: ancho completo, alto mínimo de 56 px, texto de una acción.
- **Resumen de una línea** (`#quick-summary`, `aria-live="polite"`): describe en lenguaje llano lo que se hará con las opciones vigentes, incluido el encadenado («…y después creará el video vertical»). Es la única explicación; no hay modales.
- **Chip de sugerencia**: aparece solo si el perfil sugerido difiere del respaldo. «Cambiar» abre `#advanced` y lleva el foco al selector «Perfil». Se descarta con Escape o un botón; no vuelve a aparecer para ese archivo.
- **Accesibilidad**: `<details>` nativo (teclado y lector de pantalla gratis), foco visible, el cambio de sugerencia se anuncia por la región `aria-live`, ningún control cambia de sitio al abrirse el panel. Respeta `prefers-reduced-motion` (sin animación de apertura salvo opacidad).
- **Capacidades**: los controles que el servidor no ofrece (diarización, BYOK) siguen deshabilitados con su explicación actual; un perfil que los pida los omite y lo dice en el resumen.

### 3.3 Encadenado «Sube y olvídate»

`follow-up.js` guarda, por `jobId` de la transcripción, el `followUp` solicitado (`{ burn: { canvas, template?, style? } }`). Al llegar `COMPLETED` por el seguimiento SSE ya existente:

1. comprueba que no haya un quemado en curso (el API ya responde 409; se trata como «ya está en marcha»);
2. llama a `startBurn` con las opciones guardadas;
3. el trabajo de quemado se enseña en el panel de siempre y entra en «Recientes».

Fallos: un 413 (`job_too_large`) o 409 se muestran como aviso junto al resultado, con el botón manual de siempre; no se reintenta en bucle. El `followUp` pendiente se guarda también en la entrada del historial (solo `{canvas, template}`) para que, al reabrir la pestaña con la transcripción ya completa, la interfaz **ofrezca** el quemado en lugar de ejecutarlo a ciegas.

### 3.4 Preferencias en `localStorage` (`cf-prefs`)

```json
{ "v": 1, "autoProfile": true,
  "modelSize": "small", "sourceLanguage": "", "translateTo": "",
  "cleanAudio": false, "diarize": false,
  "burnFormat": "classic", "burnTemplate": "bold-pop", "burnKaraoke": false, "autoBurn": false }  // el modo NO se guarda: siempre arranca en rápido
```

- **Se guarda** solo lo que la persona cambió explícitamente en «Control total» (no los valores sugeridos por un perfil), con un temporizador corto para no escribir a cada tecla.
- **Lectura estricta**: JSON inválido, versión distinta, claves desconocidas o valores fuera de los enums se descartan campo a campo y se usan los defaults. Tamaño máximo de 2 KiB.
- **Nunca**: claves de API, URL base, nombres de modelo de BYOK, nombres de archivo, duraciones, historial de perfiles ni nada de la sesión.
- **Fallo del almacenamiento** (modo privado, cuota, bloqueado): se sigue con los defaults y sin error visible, igual que `captionforge_lang`.
- **Capacidades distintas**: una preferencia `diarize: true` con un servidor que no lo ofrece se ignora al aplicarla, pero no se borra.
- «Restablecer preferencias» elimina la clave; también se limpia al cambiar de espacio de trabajo si la clave de API cambia (las preferencias son del navegador, no de la cuenta).

## 4. API: ajustes mínimos y compatibles

1. `GET /v1/capabilities` añade, sin quitar nada: `limits: { verticalMaxSeconds: 600 }` y `burn: { templates: ["bold-pop","rounded-sweep","clean-color"] }`. El cliente que no los reconoce usa sus constantes (mejora progresiva); uno antiguo ignora los campos nuevos.
2. `VERTICAL_MAX_SECONDS` pasa de constante del API a configuración (`verticalMaxSeconds`, misma variable de entorno que lee el worker) y `docker-compose.yml` se la pasa a ambos. Una prueba comprueba que `capabilities`, el 413 de `/burn` y el valor del worker salen de la misma variable.
3. **Sin cambios** en el contrato de `transcribe-job`, en las rutas de subida ni en las de quemado. Sin telemetría: el servidor no recibe qué perfil se sugirió ni si se aceptó.
4. Documentación: se actualizan `README`, el ADR 0024 (referencia al tope configurable) y se crea el **ADR 0025** («Perfiles de cliente y modo rápido») al terminar la fase.

## 5. Tareas (rojo → verde, cada una con commit)

| # | Tarea | Aceptación | Depende de | Tamaño |
|---|---|---|---|---|
| T1 ✅ | `domain/prefs.js` con lectura estricta y serialización | Pruebas: JSON hostil, versión ajena, claves desconocidas, valores fuera de enum, >2 KiB, almacenamiento que lanza | — | S |
| T2 ✅ | `domain/profiles.js` + prueba de paridad con los enums de los esquemas | Cada perfil produce opciones válidas según `common.v1.json`/`burn-job.v1.json` (el test lee los JSON) | — | S |
| T3 ✅ | `domain/intent.js` (tabla de reglas) | Pruebas de tabla: cada perfil, fronteras (3 min, 20 min, 60 min, tope vertical), duración desconocida, audio, lote | T2 | S |
| T4 ✅ | `domain/media-probe.js` | Pruebas con elementos falsos: éxito, `error`, tiempo agotado, revocación de la URL siempre, archivo sin duración | — | S |
| T5 ✅ | API: `capabilities.limits/burn` y `verticalMaxSeconds` configurable | Pruebas e2e de capacidades y de coherencia con `/burn`; compose actualizado | — | M |
| T6 ✅ | Cliente de capacidades: lee `limits`/`burn` con valores por defecto | Pruebas con respuestas antiguas, raras y nuevas | T5 | S |
| T7 | `ui/quick-mode.js` + marcado de `index.html` + estilos | Pruebas con DOM falso: valores seguros por defecto, resumen, chip, «Cambiar», paso a manual, lote mixto, capacidades apagadas | T1–T4, T6 | L |
| T8 | `ui/follow-up.js` y cableado en `app.js` | Pruebas: encadena al completar, 409/413 no hacen bucle, nada si el usuario cerró o cambió de trabajo | T7 | M |
| T9 | i18n en los 6 idiomas (≈35 claves `quick.*`, `profile.*`, `advanced.*`) y guía actualizada | La comprobación de idiomas pasa; revisión de longitudes en alemán | T7 | M |
| T10 | e2e de navegador | Un clic con valores por defecto crea el mismo trabajo que hoy; un video vertical muestra la sugerencia y encadena el quemado; las preferencias sobreviven a la recarga; con `localStorage` bloqueado todo funciona; teclado y lector (roles/etiquetas) | T7–T9 | M |
| T11 | ADR 0025, CHANGELOG `[Sin publicar]`, README y guía | Pruebas de documentación | todas | S |

**Checkpoints.** Tras T1–T4 (dominio puro, sin DOM); tras T5–T6 (backend y capacidades; se reporta el estado de las pruebas del API antes de tocar la interfaz); tras T7–T10 (interfaz completa).

## 6. Riesgos y mitigaciones (pre-mortem)

| Riesgo | Impacto | Mitigación |
|---|---|---|
| La sugerencia acierta mal y confunde | Medio | Siempre con motivo visible y un clic para cambiarla; el respaldo equivale a hoy; reglas en una tabla ajustable |
| El encadenado consume tiempo del worker sin que la persona lo espere | Medio | Solo el quemado; aparece en el resumen **antes** de pulsar; se desactiva con un clic; respeta el tope y el 409 |
| «Olvídate» promete más de lo que cumple (hay que dejar la pestaña abierta) | Alto (confianza) | Texto explícito en el resumen y en la guía; el trabajo queda en Recientes con el botón manual; migrable al servidor en la fase 3 |
| Leer metadatos de un archivo enorme bloquea o gasta memoria | Bajo | `preload="metadata"`, sin decodificar, tiempo máximo de 4 s, URL siempre revocada, una sonda a la vez en lotes |
| El navegador no puede leer el formato (MKV, AVI) | Bajo | Campos `null` → perfil Estándar con motivo; nunca bloquea |
| `localStorage` manipulado o corrupto inyecta valores | Medio | Lista blanca de enums, versión, tope de tamaño, sin claves ni secretos |
| Regresión de pruebas existentes por mover los controles | Medio | Se mantienen los `id` y `#start`; las suites actuales (web, e2e de navegador) deben pasar sin editarse salvo lo estrictamente nuevo |
| Dos valores del tope vertical divergen | Bajo | Configuración única + prueba de coherencia (D8) |

## 7. Preguntas abiertas

Resueltas en §0. Quedan para la interfaz (T7 en adelante): textos exactos de los motivos (`intent.<code>`) en los 6 idiomas y la longitud del resumen en alemán.
