# Registro de cambios

Todos los cambios relevantes de CaptionForge se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Las referencias `#N` son issues o pull requests del
repositorio [Bryandero98/captionforge](https://github.com/Bryandero98/captionforge); cuando hace falta distinguirlos se escribe
«issue» o «PR». El detalle de cada decisión está en los [ADR](docs/adr).

## [Sin publicar]

## [1.2.0] - 2026-10-24

Subtítulos dinámicos y formato vertical para Shorts, Reels y TikTok, con dos parches de seguridad. Issue #13 (parte 2), PR #35 y PR de la versión.

### Issue #13: subtítulos dinámicos ASS y formato vertical 9:16

[ADR 0024](docs/adr/0024-subtitulos-ass-y-formato-vertical.md) · [ADR 0022](docs/adr/0022-url-base-propia-para-proveedores-de-ia.md)

#### Añadido

- **Renderizado vertical 1080×1920 (9:16)**: el video queda centrado sobre su propio fondo desenfocado, en un solo pase de ffmpeg (`libx264 veryfast`,
  CRF 21). Una entrada ya vertical rellena el lienzo sin fondo. Tope de 10 minutos (`413 job_too_large` antes de encolar).
- **Tres plantillas de subtítulos dinámicos** con resaltado palabra por palabra (`bold-pop`, `rounded-sweep`, `clean-color`), generadas por un compilador `.ass`
  puro y paginado, con el texto escapado frente a la inyección de etiquetas.
- **Texto editado o traducido**: los tiempos se alinean con `difflib` y se reparten; el resultado informa `approximateSegments` y la interfaz muestra un aviso.
- **Fuentes integradas** Montserrat ExtraBold y Nunito ExtraBold (SIL OFL 1.1) en la imagen del worker, con `SHA256SUMS` verificado en la CI,
  `THIRD_PARTY_NOTICES.md` y comprobación en la imagen de que libass las resuelve de verdad.
- **Interfaz**: selector «Formato» (Clásico 16:9 / Vertical Shorts 9:16) con plantillas, en los 6 idiomas, y la guía de usuario actualizada.
- Contrato `burn-job` con `options.template` y `options.canvas` opcionales; `burn-result` con `approximateSegments`. Sin ellos, el quemado no cambia.

### Seguridad

- **Condición de carrera en trabajos derivados** (PR #35): un índice único parcial en PostgreSQL impide dos quemados, traducciones o doblajes activos de la misma
  transcripción; la violación se traduce a `409`. Antes, peticiones simultáneas podían pasar la comprobación previa y crear duplicados.
- **TOCTOU / DNS rebinding en las URL base propias** (ADR 0022): `assert_url_allowed` devuelve un `ResolvedTarget` inmutable y un transporte de httpx con la conexión TCP
  fijada a esa IP (`PinnedAsyncTransport`) conserva el Host, el SNI y la verificación del certificado del nombre original, sin `verify=False`. Se resuelve y se
  valida antes de cada intento, las redirecciones no se siguen y `httpx` / `httpcore` quedan acotados a un rango estrecho.

## [1.1.0] - 2026-10-24

Multi-LLM con URL base propia y soporte de audio puro. Issue #14, PR #33.

### Issue #14: Multi-LLM con URL base propia y audio puro

[ADR 0022](docs/adr/0022-url-base-propia-para-proveedores-de-ia.md) · [ADR 0023](docs/adr/0023-audio-puro-como-entrada.md)

#### Añadido

- La clave de OpenAI admite una **URL base** y un **modelo** propios: DeepSeek, Gemini, Claude (capa de compatibilidad), Groq, OpenRouter,
  Abacus u Ollama. El panel «Claves externas» trae un menú de servicios que rellena la URL y sugiere modelos. Los servidores locales solo con
  `ALLOW_PRIVATE_BASE_URLS=true`; el worker resuelve el DNS en cada petición y no envía la clave a direcciones no permitidas.
- **Audio puro** como entrada (MP3, WAV, M4A, OGG y FLAC): `mediaKind` en el trabajo, reproductor `<audio>` del original
  (`GET /v1/jobs/:id/artifacts/source`, solo audio), doblaje a pista `.mp3`. Quemar subtítulos y mezclar el doblaje sobre un audio se
  rechazan (`burn_not_available_for_audio`, `mix_not_available_for_audio`; en el worker `BURN_NEEDS_VIDEO`, `MIX_NEEDS_VIDEO`).

## [1.0.1] - 2026-10-24

Ajustes tras las primeras pruebas de uso. PR #31.

### Añadido

- Puerto configurable con `CF_PORT` (`.env.example`, compose, `start.sh` y `start.bat`), con validación y pruebas; el README explica cómo
  cambiarlo.
- Consumo sugerido en la guía, en «Claves externas» y en la confirmación de gasto, en los 6 idiomas: 15, 30, 45 y 60 s equivalen a
  200, 400, 600 y 800 caracteres (≈ 50, 100, 150 y 200 tokens).
- El README lista los idiomas compatibles de transcripción (Whisper) y de traducción (Argos).

### Corregido

- `GET /v1/jobs` tiene un tope propio en el servicio (máximo 100 por página): nunca consulta sin límite.

### Interno

- Las pruebas de puerto y de documentación se ejecutan en la CI.

## [1.0.0] - 2026-10-23

Reescritura del paquete local como servicio distribuido (API Gateway en NestJS, AI Worker en Python, PostgreSQL, Redis/BullMQ y
S3) con tenencia, inicio de sesión, equipos, perímetro de producción y, en el último hito, IA avanzada con claves propias. El
paquete anterior sigue en [`legacy/`](legacy).

### Hito: IA avanzada y claves propias (BYOK), issue #11, PR en revisión

[ADR 0020](docs/adr/0020-ia-avanzada-y-claves-externas-byok.md) · [runbook de `APP_SECRET`](docs/runbook-app-secret.md)

#### Añadido

- Traducir los subtítulos de una transcripción terminada, como trabajo aparte (`TRANSLATE`): con Argos local (sin clave ni costo)
  o con OpenAI. `POST /v1/jobs/:id/translate`; descargas del `.srt` y el `.vtt` traducidos.
- Doblar con voz sintética (`DUB`): proveedores OpenAI y ElevenLabs, voz a elección, y salida en `.mp3` o en un `.mp4` con la
  voz en lugar del audio original (`replace`) o con el original bajado bajo la voz (`duck`). Se puede doblar el original o una
  traducción terminada. Cada frase se ajusta entre 0,85x y 1,25x y nunca se solapan dos voces; las que no caben se informan en
  `overflowSegments`. `POST /v1/jobs/:id/dub`.
- Claves externas por espacio de trabajo (OpenAI y ElevenLabs): `GET`, `PUT` y `DELETE` en
  `/v1/workspaces/current/external-keys`, solo para el Dueño con sesión. La API nunca devuelve la clave (solo proveedor y
  últimos 4 caracteres). Tabla `TenantExternalKey` y migración `external_keys`.
- Canal interno del API para el worker: `POST /internal/v1/jobs/:jobId/external-key` en el puerto 3100, solo en la red de
  Docker, autenticado con `WORKER_INTERNAL_TOKEN`.
- Capacidad `byok` en `GET /v1/capabilities` (`enabled` y `providers`).
- Códigos de error `EXTERNAL_KEY_MISSING`, `EXTERNAL_AUTH_FAILED`, `EXTERNAL_RATE_LIMITED`, `EXTERNAL_QUOTA_EXCEEDED`,
  `EXTERNAL_TIMEOUT`, `EXTERNAL_UNAVAILABLE` y `JOB_TOO_LARGE`; colas propias `translate` y `dub`; contratos JSON Schema
  `translate-job`, `translate-result`, `dub-job` y `dub-result`.
- Topes de gasto por trabajo: `MAX_JOB_CHARACTERS` (50 000 por defecto) y `MAX_JOB_SEGMENTS` (1 000). Si se superan, 413
  `job_too_large` antes de encolar.
- Interfaz: panel «Claves externas» (solo Dueño), paneles «Traducir los subtítulos» y «Doblar con voz sintética», y cuadro de
  confirmación de gasto («≈ N caracteres») antes de enviar texto a un proveedor externo.
- Variables nuevas: `APP_SECRET`, `WORKER_INTERNAL_TOKEN`, `INTERNAL_PORT`, `INTERNAL_HOST`, `API_INTERNAL_URL` y
  `INTERNAL_RATE_LIMIT_PER_MINUTE`.
- Documentación: ADR 0020, sección 3.4 de [architecture_and_security.md](docs/architecture_and_security.md), secciones de las
  guías de uso ([ES](docs/guia-de-uso.md), [EN](docs/user-guide.md)) y el
  [runbook de `APP_SECRET`](docs/runbook-app-secret.md).

#### Cambiado

- **Licencia:** pasa de MIT a Business Source License 1.1 (Licenciante: Bryan Andrés Delgado Rodríguez; Apache 2.0 desde 2030-10-23). El uso comercial o en producción requiere licencia; el README añade la sección «Contribuciones».
- `start.sh` y `start.bat` generan `APP_SECRET` y `WORKER_INTERNAL_TOKEN` aleatorios si faltan y nunca pisan uno existente; `.env.example` documenta ambos y los topes `MAX_JOB_CHARACTERS` y `MAX_JOB_SEGMENTS`, que el compose ahora pasa al API y al worker. Caddy cierra `/internal`.
- Sin sesión (modo local) la interfaz no ofrece BYOK: no hay panel de claves y «Doblar» queda bloqueado con una explicación;
  «Traducir» sigue con Argos.
- 409 `external_key_missing` o `byok_disabled` antes de encolar si falta la clave o la función está apagada, y un solo trabajo
  activo de traducir y de doblar por transcripción.

#### Seguridad

- Las claves se guardan cifradas con AES-256-GCM; la clave de cifrado se deriva de `APP_SECRET` con HKDF-SHA256 y el dato
  autenticado une espacio, proveedor y versión. `APP_SECRET` debe ser aleatorio y de 32 bytes o más: si es débil, el API no
  arranca; si falta, la función queda apagada.
- `cf_worker` no tiene ningún permiso sobre `TenantExternalKey` y `APP_SECRET` no está en su entorno. La clave de un trabajo la
  pide el worker por el canal interno, solo mientras el trabajo está en curso, y vive solo en memoria: no pasa por Redis ni
  por registros ni por mensajes de error.
- Las URL de los proveedores están fijas en el código, sin redirecciones ni proxies del entorno. Los errores del proveedor se
  sustituyen por mensajes propios.
- 401 y 402 del proveedor no se reintentan; 429 y 5xx, con retroceso exponencial.
- Prueba «canario» que busca una clave señuelo en Redis, la base, los registros y la carpeta de trabajo, y prueba de que el
  puerto interno no se publica en `docker-compose.yml`.
- Límite conocido: la rotación de `APP_SECRET` con re-cifrado queda aplazada. Cambiar o perder el secreto obliga a volver a
  pegar las claves ([runbook](docs/runbook-app-secret.md)).

### Hito: equipos, roles e invitaciones, issue #10, PR #29

[ADR 0019](docs/adr/0019-equipos-membresias-roles-e-invitaciones.md)

#### Añadido

- Membresías con roles Dueño, Editor y Lector, y varios espacios por persona con selector de espacio activo.
- Invitaciones de un solo uso con pantalla de confirmación («¿Deseas unirte a este espacio?»); nunca se une solo.
- Gestión de miembros con la regla del último Dueño.

#### Seguridad

- `RolesGuard` que deniega si una ruta no declara rol, con una prueba que recorre todas las rutas.
- Hallazgos de la auditoría v1.0-RC cerrados: bloqueo por persona, claves de API por creador y Redis que falla rápido.

### Hito: perímetro de producción, cuotas y observabilidad, issues #8 y #9, PR #28

[ADR 0017](docs/adr/0017-perimetro-caddy-y-cuotas-por-tenant.md) · [ADR 0018](docs/adr/0018-observabilidad-registros-json-y-metrics.md)

#### Añadido

- Caddy como perfil `proxy` (TLS automático e IP real del cliente) y Prometheus con Grafana como perfil `metrics`.
- Cuotas por espacio en Redis (subidas por hora y trabajos en curso), con fail-open si Redis cae.
- Registros JSON con `X-Request-Id` en el API y en el worker, y `/metrics` en un puerto interno.

### Hito: inicio de sesión, issue #7, PR #27

[ADR 0016](docs/adr/0016-inicio-de-sesion-y-sesiones.md)

#### Añadido

- Inicio de sesión con GitHub o Google (OAuth con PKCE), sesiones por cookie y claves de API creadas desde la sesión.
- Pantalla de entrada, barra de cuenta y panel de claves de API.
- Prueba de inicio de sesión de punta a punta en un navegador real.

### Hito: tenencia y claves de API, issue #6, PR #26

[ADR 0015](docs/adr/0015-tenencia-y-claves-de-api.md)

#### Añadido

- Espacios de trabajo (tenants), personas y claves de API, con migración que rellena los datos antes de `NOT NULL`.
- Guardián por clave de API y aislamiento de datos por tenant: otro tenant ve 404. `GET /v1/jobs`.
- La interfaz manda la clave de API; descargas y video por `fetch` y `Blob`.

#### Corregido

- `init-roles.sql` mantiene los permisos mínimos de la tenencia al volver a ejecutarse.

### Hito: arranque con Docker, issue #2, PR #25

#### Añadido

- `start.sh` y `start.bat` levantan todo en local con Docker con un solo comando y crean el `.env` con contraseñas aleatorias.
- Guía de problemas del primer arranque en el README.

### Hito: identificar quién habla, issue #4, PR #24

[ADR 0014](docs/adr/0014-identificar-quien-habla-pyannote.md)

#### Añadido

- Opción «Identificar quién habla» (pyannote 3.1 en subproceso), con respaldo a la transcripción normal si falla.
- Capacidad de diarización en `GET /v1/capabilities`, campo `speaker` en los segmentos y la opción en la interfaz.

### Hito: limpieza de ruido de fondo, issue #5, PR #23

[ADR 0013](docs/adr/0013-limpieza-de-audio-demucs-en-subproceso.md)

#### Añadido

- Opción «Limpiar ruido de fondo» (Demucs en subproceso), desactivada por defecto, con respaldo al audio original si falla.
- Indicador «Audio limpiado» en el resultado.

### Hito: cliente web sobre el nuevo API, PR #21 y #22

[ADR 0012](docs/adr/0012-frontend-vanilla-sse.md)

#### Añadido

- Interfaz servida por el propio API, con CSP restrictiva y mismo origen; subida con progreso y cancelación.
- Seguimiento del trabajo por SSE propio con reconexión, resultados, descargas `.srt` y `.vtt`, historial y editor de
  subtítulos con guardado parcial y resolución del conflicto 409.
- Quemado de subtítulos como trabajo propio, cola de varios videos, guía de uso y seis idiomas (ES, EN, PT, FR, DE, IT) con
  detección del navegador.

#### Corregido

- Tras un rechazo temprano se descarta el cuerpo restante para que el navegador vea 413 y 429.

### Antes de 1.0

#### Documentación, PR #20

- README del monorepo en inglés y español, con diagrama de arquitectura, API, seguridad y hoja de ruta.

#### Cadena de suministro y seguridad, PR #9, #10 y #11

- Acciones de GitHub fijadas por SHA, permisos de solo lectura y publicación en PyPI por Trusted Publishing en dos jobs.
- Guardia contra páginas ajenas (`Host`, `Origin`, `Sec-Fetch-Site` y CORS cerrado) y verificador de workflows por árbol YAML.
- Topes de subidas y de flujos SSE simultáneos, apagado ordenado del worker con plazo y limpieza de `/work` al arrancar.
- ffmpeg con un entorno mínimo, sin los secretos del worker. La imagen del worker incluye fontconfig y fuentes para el quemado.
- Documento [architecture_and_security.md](docs/architecture_and_security.md) con los límites declarados.

#### Servicio distribuido, PR #8

- Monorepo con API Gateway (NestJS), AI Worker (Python/BullMQ), contratos JSON Schema, PostgreSQL con roles de mínimo
  privilegio, S3 con RustFS, y trabajos huérfanos recogidos por el API. El paquete anterior se mueve a `legacy/`.

#### Procesos de ffmpeg, PR #6 y #7

- ffmpeg se incluye con la instalación (`imageio-ffmpeg`), de modo que no hay que instalarlo aparte.
- Se corrige la fuga de procesos de ffmpeg y se añaden tiempos máximos a los subprocesos.

#### Versiones 0.1.0 y 0.2.0 (paquete local)

- 0.1.0: subtítulos automáticos locales con interfaz web bilingüe (ES/EN), subtítulos karaoke, edición, exportación `.vtt` y
  `.ass`, estilos e historial de trabajos.
- 0.2.0: cola de varios videos, confianza por palabra, ajuste de tiempos arrastrando la forma de onda y CI en Windows y macOS.
