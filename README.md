# CaptionForge

Subtitulado automático de video (transcripción con Whisper, traducción y quemado de subtítulos),
rediseñado como un sistema distribuido dirigido por eventos.

> **Estado: reescritura en curso (rama `feat/monorepo-foundation`).**
> El paquete Python publicado en PyPI sigue intacto en [`legacy/`](legacy/README.md) y es lo que
> usa hoy la gente. Este monorepo es la nueva base: contratos, infraestructura, API Gateway y AI
> Worker (transcripción y quemado). El cliente web (`apps/web`) está en curso y falta el endurecimiento final.
> Ver [docs/architecture.md](docs/architecture.md).

## Qué hay aquí

| Carpeta | Contenido | Estado |
|---|---|---|
| [`packages/contracts`](packages/contracts) | Esquemas JSON (fuente de verdad) y los tipos TypeScript y modelos Pydantic generados | Hecho |
| [`docker-compose.yml`](docker-compose.yml) + [`docker/`](docker) | PostgreSQL, Redis, almacenamiento S3 y roles de mínimo privilegio | Hecho |
| [`tools/smoke`](tools/smoke) | Prueba de extremo a extremo Node → Redis → Python | Hecho |
| [`apps/api-gateway`](apps/api-gateway) | API NestJS 12 + Prisma 7: subida a S3, cola, estado, SSE, cancelación, edición de subtítulos, quemado, descarga | Hecho |
| [`apps/ai-worker`](apps/ai-worker) | Worker Python: Whisper, traducción, quemado con ffmpeg; estado en PostgreSQL | Hecho |
| [`tools/e2e`](tools/e2e) | Prueba de extremo a extremo con el stack completo en contenedores | Hecho |
| [`legacy/`](legacy) | Paquete Python actual (CLI + servidor web local) | Sin cambios |

## Puesta en marcha

Requisitos: Docker, Node ≥ 22 y Python ≥ 3.11.

1. Instala las dependencias: `npm install`
2. Crea tus secretos: copia `.env.example` a `.env` y rellena cada valor
   (`node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"` genera uno).
3. Levanta la infraestructura: `npm run infra:up`
4. Comprueba que los permisos son los esperados: `npm run infra:verify`
5. Prepara el entorno de los contratos y del smoke test (una sola vez):
   ```
   python -m venv packages/contracts/.venv
   packages/contracts/.venv/bin/python -m pip install -r packages/contracts/requirements-dev.txt
   python -m venv tools/smoke/.venv
   tools/smoke/.venv/bin/python -m pip install -r tools/smoke/requirements.txt
   ```
   (en Windows, `Scripts\python.exe` en lugar de `bin/python`)
6. Prueba el contrato de extremo a extremo: `npm run smoke`
7. Al terminar, apaga todo: `npm run infra:down`

`api-gateway` y `ai-worker` **no** se levantan en desarrollo local: se ejecutan de forma nativa
contra la infraestructura dockerizada para no gastar RAM. Para un despliegue completo:
`docker compose --profile app up -d --build` (y `docker compose ps` para ver la salud). Después,
`npm run e2e` sube un video, lo transcribe, edita un subtítulo, lo quema y descarga el MP4.

## API

Todo cuelga de `/v1/jobs`. El estado lo escribe el worker en PostgreSQL; el API lo lee. Con `API_KEY`
definida (ver `.env.example`) todas las rutas piden `Authorization: Bearer <clave>`; `/health` queda abierto.

| Método y ruta | Qué hace |
|---|---|
| `POST /v1/jobs/transcribe` | Multipart (`options` JSON antes de `file`). Sube el video a S3 mientras llega. `202` |
| `GET /v1/jobs/:id` | Estado, etapa, porcentaje, error y resultado |
| `GET /v1/jobs/:id/events` | Progreso por SSE hasta un estado final |
| `POST /v1/jobs/:id/cancel` | Cancela: en cola se quita; en curso se avisa al worker |
| `GET /v1/jobs/:id/segments` | Subtítulos con `index` y el `etag` vigente |
| `PUT /v1/jobs/:id/segments` | Edita texto y/o tiempos por índice (`etag` opcional: `409` si cambiaron) |
| `POST /v1/jobs/:id/burn` | Quema los subtítulos actuales: `{ "style": "modern", "karaoke": false }`. `202` |
| `GET /v1/jobs/:id/artifacts/:name` | `srt`, `segments`, `waveform` (transcripción) o `video` (quemado); admite `Range` |

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run contracts:gen` | Regenera los tipos TypeScript y los modelos Pydantic desde los esquemas |
| `npm run contracts:check` | Falla si lo generado no coincide con los esquemas (se usa en CI) |
| `npm run contracts:test` | Pruebas de los contratos en Node (Ajv) y en Python (Pydantic), con los mismos ejemplos |
| `npm run infra:up` / `infra:down` | Levanta o apaga PostgreSQL, Redis y S3 |
| `npm run infra:verify` | Comprueba permisos: lo permitido funciona y lo prohibido falla |
| `npm run smoke` | Productor Node → Redis → worker Python con BullMQ real |
| `npm run migrate -w @captionforge/api-gateway` | Aplica las migraciones de Prisma con el rol dueño (`cf_owner`) |
| `npm test -w @captionforge/api-gateway` | Pruebas del API contra PostgreSQL, Redis y S3 reales |
| `npm run worker:test` | Pruebas del worker con ffmpeg, PostgreSQL, Redis y S3 reales (Whisper simulado; `WHISPER_E2E=1` usa el real) |
| `npm run e2e` | Extremo a extremo contra el stack completo en contenedores (descarga el modelo la primera vez) |
| `npm run compose:check` | Valida `docker-compose.yml` con y sin el perfil `app` |

## Decisiones

Los porqués están en [docs/adr/](docs/adr): contratos por esquema, `objectKey` en vez de URLs,
Python directo a PostgreSQL, almacenamiento S3 sin MinIO, reglas del worker, desarrollo local,
el API en NestJS, por qué el worker reutiliza `legacy/` en lugar de copiarlo y el endurecimiento
del API (clave opcional, límites de uso, trabajos huérfanos).

## Licencia

[MIT](LICENSE)
