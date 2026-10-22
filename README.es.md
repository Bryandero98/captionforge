# CaptionForge

[English](README.md) | **Español**

[![CI del monorepo](https://github.com/Bryandero98/captionforge/actions/workflows/monorepo.yml/badge.svg)](https://github.com/Bryandero98/captionforge/actions/workflows/monorepo.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

Subtítulos automáticos para video, gratuitos - transcripción, traducción y subtítulos quemados -
sin marca de agua ni límite mensual, y hoy sin cuenta. CaptionForge empezó como una herramienta
local de un solo proceso y se está reconstruyendo como un **servicio distribuido dirigido por
eventos**, pensado para resistir fallos y carga: topes explícitos, apagado ordenado y recuperación
de trabajos huérfanos. Sus límites conocidos se declaran, no se esconden.

- **Transcripción** con [faster-whisper](https://github.com/SYSTRAN/faster-whisper),
  **traducción** a cualquier idioma con [argos-translate](https://github.com/argosopentech/argos-translate)
  y **subtítulos quemados** con [ffmpeg](https://ffmpeg.org/) en cuatro estilos (Moderno, TikTok en
  negrita, YouTube clásico y Mínimo), con resaltado opcional palabra por palabra (karaoke).
- **Salida** en `.srt` (y `.vtt` y `.ass` en el paquete local), o el video con los subtítulos quemados.
- **Editable**: corrige el texto y ajusta los tiempos antes de quemar; una edición desactualizada se
  rechaza (`409`) en lugar de pisar en silencio la de otra persona.
- **Progreso en vivo** por Server-Sent Events, sin consultar cada poco.

> **Dos formas de usarlo**
>
> | | Qué es | Estado |
> |---|---|---|
> | **Paquete local** | `pip install` + `captionforge serve` (Python 3.10+): un proceso, un video a la vez, nada sale de tu equipo. | Publicado en PyPI. Ver [`legacy/`](legacy/README.es.md). |
> | **Servicio (este monorepo)** | API Gateway + cola + AI Worker + almacenamiento de objetos, pensado para varios trabajos y varias personas. | API y worker hechos; cliente web y cuentas pendientes. |

## Puesta en marcha (servicio)

Requisitos: Docker, Node >= 22 y Python >= 3.11.

```sh
npm install
cp .env.example .env        # rellena cada valor (ver la nota de abajo)
npm run infra:up            # PostgreSQL, Redis y S3 (RustFS)
npm run infra:verify        # permisos: lo permitido funciona y lo prohibido falla
```

Genera un secreto con `node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"`.
Los secretos viven en `.env` (ignorado por git), nunca en el repositorio.

Los comandos de contratos y de la prueba de humo necesitan sus entornos de Python, que se crean una vez:

```sh
python -m venv packages/contracts/.venv
packages/contracts/.venv/bin/python -m pip install -r packages/contracts/requirements-dev.txt
python -m venv tools/smoke/.venv
tools/smoke/.venv/bin/python -m pip install -r tools/smoke/requirements.txt
```

(en Windows, `Scripts\python.exe` en lugar de `bin/python`).

En desarrollo local, `api-gateway` y `ai-worker` se ejecutan **de forma nativa** contra la
infraestructura dockerizada, para ahorrar RAM. Para un despliegue completo:

```sh
docker compose --profile app up -d --build
docker compose ps           # salud de cada servicio
npm run e2e                 # sube un video, lo transcribe, edita un subtítulo, lo quema y descarga el MP4
docker compose --profile app down   # apaga todo al terminar (`npm run infra:down` solo apaga la infraestructura)
```

### Pruébalo

```sh
# Crea un trabajo de transcripción (el JSON `options` va antes de `file`;
# modelSize: base | small | medium, translateTo: un código de idioma o null)
curl -F 'options={"modelSize":"base","translateTo":"es"}' -F file=@clip.mp4 http://127.0.0.1:3000/v1/jobs/transcribe
# -> 202 { "id": "..." }

# Síguelo en vivo (Server-Sent Events) y lee el resultado
curl -N http://127.0.0.1:3000/v1/jobs/<id>/events
curl -OJ http://127.0.0.1:3000/v1/jobs/<id>/artifacts/srt
```

Con `API_KEY` definida, añade `-H "Authorization: Bearer <clave>"` a cada llamada.

## API

Todo cuelga de `/v1/jobs`. El worker escribe el estado del trabajo en PostgreSQL y el API lo lee. Con
`API_KEY` definida (ver `.env.example`) todas las rutas piden `Authorization: Bearer <clave>`;
`/health` queda abierto.

| Método y ruta | Qué hace |
|---|---|
| `POST /v1/jobs/transcribe` | Multipart. Sube el video a S3 mientras llega. `202` |
| `GET /v1/capabilities` | Funciones opcionales de este servidor (`{ "diarization": { "enabled": true } }`); la web oculta o desactiva lo que falte |
| `GET /v1/jobs/:id` | Estado, etapa, porcentaje, error y resultado |
| `GET /v1/jobs/:id/events` | Progreso por SSE hasta un estado final |
| `POST /v1/jobs/:id/cancel` | Cancela: en cola se quita; en curso se avisa al worker |
| `GET /v1/jobs/:id/segments` | Subtítulos con `index` y el `etag` vigente |
| `PUT /v1/jobs/:id/segments` | Edita texto y/o tiempos por índice (`etag` opcional: `409` si cambiaron) |
| `POST /v1/jobs/:id/burn` | Quema los subtítulos actuales: `{ "style": "modern", "karaoke": false }`. `202` |
| `GET /v1/jobs/:id/artifacts/:name` | `srt`, `segments`, `waveform` (transcripción) o `video` (quemado); admite `Range` |

## Arquitectura

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.es.svg">
  <img src="docs/architecture-light.es.svg" alt="Diagrama: un navegador sube un video al API Gateway de NestJS, que lo transmite a S3, registra el trabajo en PostgreSQL y lo encola en Redis/BullMQ. Un worker de IA en Python toma el trabajo, lee y escribe artefactos en S3, actualiza el estado en PostgreSQL con transiciones condicionales, y el gateway devuelve el progreso al navegador por Server-Sent Events.">
</picture>

Dos procesos que no comparten disco ni memoria: un **API Gateway** que atiende a las personas
usuarias y un **AI Worker** que hace el trabajo pesado (Whisper, ffmpeg, traducción). Se hablan por
una cola (Redis/BullMQ) y por un almacén de objetos (S3); los mensajes son esquemas JSON versionados
y los archivos se nombran con `bucket` + `objectKey`, nunca con URLs. Cada servicio tiene el mínimo
privilegio que le basta: roles de base de datos y políticas S3 separados, de modo que un worker
comprometido no puede borrar tablas ni salir de `jobs/`.

```text
apps/
  api-gateway/       NestJS 12 + Fastify + Prisma: subida a S3, cola, SSE, cancelación, subtítulos, quemado
    src/security/      guardia de Host/Origin, limitador de concurrencia, clave de cliente
    src/storage/       subida multipart en streaming a S3
  ai-worker/         Python: consumidor de BullMQ, Whisper, traducción, ffmpeg; estado directo a PostgreSQL
packages/
  contracts/         Esquemas JSON (fuente de verdad) + tipos TypeScript y modelos Pydantic generados
docker/              roles de PostgreSQL, buckets y políticas de S3, comprobación de permisos
tools/
  smoke/             prueba de contrato Node -> Redis -> Python con BullMQ real
  e2e/               extremo a extremo contra el stack completo en contenedores
legacy/              el paquete pip local publicado (CLI + servidor web local)
docs/
  adr/               por qué se tomó cada decisión
  architecture.md    componentes, quién puede qué, reglas del worker, fases
  architecture_and_security.md   postura de seguridad y resiliencia, con límites declarados
```

### Seguridad y resiliencia

Diseñado para que el modo de fallo sea «rechazar, cortar o no hacer nada» y no «ejecutar sin
comprobar»:

- **Ataques desde el navegador:** guardia fail-closed de `Host` / `Origin` / `Sec-Fetch-Site` y lista
  cerrada de CORS contra CSRF y DNS rebinding ([ADR 0011](docs/adr/0011-origen-y-host-fail-closed-contra-paginas-ajenas.md)).
- **Memoria y sockets acotados:** las subidas van a S3 en partes de 5 MiB con tope total y por
  cliente y un ritmo mínimo; los flujos SSE tienen un tope global, uno por cliente y una duración
  máxima.
- **Los secretos no llegan a los subprocesos:** ffmpeg corre con un entorno de lista blanca.
- **Apagado ordenado:** el worker deja terminar el trabajo en curso dentro de un plazo; pasado el
  plazo le pide parar y lo cierra como fallido, y limpia su volumen efímero `/work`, también los
  restos de una caída al arrancar.
- **Cadena de suministro:** acciones de GitHub fijadas por SHA, permisos de solo lectura en los
  workflows comprobados en el CI y un workflow de publicación preparado para Trusted Publishing
  (OIDC) en PyPI, sin token de larga vida en el workflow.

El cuadro completo, con lo que **todavía no** está cubierto, está en
[docs/architecture_and_security.md](docs/architecture_and_security.md).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run contracts:gen` / `contracts:check` / `contracts:test` | Regenera los tipos TypeScript y los modelos Pydantic; falla si se desvían (se usa en CI); prueba ambos con los mismos ejemplos |
| `npm run infra:up` / `infra:down` | Levanta o apaga PostgreSQL, Redis y S3 |
| `npm run infra:verify` | Comprueba permisos: lo permitido funciona y lo prohibido falla |
| `npm run smoke` | Productor Node -> Redis -> worker Python con BullMQ real |
| `npm run infra:logs` | Sigue los registros de la infraestructura |
| `npm run migrate -w @captionforge/api-gateway` | Aplica las migraciones de Prisma con el rol dueño (`cf_owner`) |
| `npm test -w @captionforge/api-gateway` | Pruebas del API contra PostgreSQL, Redis y S3 reales |
| `npm run worker:test` | Pruebas del worker con ffmpeg, PostgreSQL, Redis y S3 (Whisper simulado; `WHISPER_E2E=1` usa el real) |
| `npm run e2e` | Extremo a extremo contra el stack completo en contenedores (descarga el modelo la primera vez) |
| `npm run workflows:check` | Falla si un workflow no tiene permisos de solo lectura o una acción no está fijada por SHA |
| `npm run compose:check` | Valida `docker-compose.yml` con y sin el perfil `app` |

## Estado y hoja de ruta

| Fase | Contenido | Estado |
|---|---|---|
| 0-3 | Monorepo, contratos, infraestructura, API Gateway, AI Worker | Hecha |
| 4a | Edición de subtítulos, cola de quemado, descarga con `Range` | Hecha |
| 5a | Endurecimiento: límites, trabajos huérfanos, guardia Host/Origin, cadena de suministro | Hecha |
| **4b** | **Cliente web sobre el nuevo API** (REST, subida multipart asíncrona, SSE en vivo) | **Siguiente** |
| 5b | Cuentas de personas usuarias, propiedad de los trabajos, observabilidad, despliegue | Pendiente |

Después del cliente web, ideas que valen la pena y que no se han empezado a propósito:

- **Diarización de hablantes** («quién dijo qué») - [issue #4](https://github.com/Bryandero98/captionforge/issues/4): implementada como opción «identificar quién habla» del servicio (pyannote 3.1 en un subproceso, necesita un token de Hugging Face de solo lectura en el worker y vuelve a la transcripción normal si falla; ver el [ADR 0014](docs/adr/0014-identificar-quien-habla-pyannote.md) y la [guía de uso](docs/guia-de-uso.md#activar-la-identificación-de-hablantes)).
- **Separación de voz y fuente** antes de transcribir, para audio con ruido - [issue #5](https://github.com/Bryandero98/captionforge/issues/5).
- **Un instalador nativo completo** del paquete local (multiplataforma, firmado, con ffmpeg incluido) - [issue #2](https://github.com/Bryandero98/captionforge/issues/2); ya existe un primer paso en [`legacy/`](legacy/README.es.md).
- **Aislar ffmpeg** en su propio usuario o contenedor (el entorno mínimo evita la herencia accidental
  de secretos, no un ffmpeg ya comprometido).

## Decisiones

Los porqués están en [docs/adr/](docs/adr): contratos por esquema JSON, `objectKey` en vez de URLs,
BullMQ con worker Python, Python directo a PostgreSQL, almacenamiento S3 con RustFS, reglas del worker, desarrollo local, el
API en NestJS, por qué el worker reutiliza `legacy/` en lugar de copiarlo, el endurecimiento del API
y la guardia de Host/Origin que falla cerrada.

## Contribuir

Las sugerencias sobre lo que CaptionForge debería hacer después son bienvenidas, no solo los
reportes de errores: abre un issue con lo que quisieras, aunque sea a grandes rasgos. Mira
[CONTRIBUTING.md](CONTRIBUTING.md) para enviar un PR.

## Apoya este proyecto

CaptionForge es gratuito por diseño y lo seguirá siendo. Una propina no desbloquea nada; va hacia
pagar algún día un servidor de verdad, para que quien no quiera instalar nada también tenga esa
opción:

- **Ko-fi:** [ko-fi.com/bryandero98](https://ko-fi.com/bryandero98)
- **USDT (TRC20):** `TEG4Kk2qXYMQ4mHNd7dPhSPRyT14CGr2or` - verifica que la red sea **TRC20** antes de
  enviar; una transferencia por otra red no se puede recuperar.

## Licencia

[MIT](LICENSE)
