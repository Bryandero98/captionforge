# CaptionForge

Subtitulado automático de video (transcripción con Whisper, traducción y quemado de subtítulos),
rediseñado como un sistema distribuido dirigido por eventos.

> **Estado: reescritura en curso (rama `feat/monorepo-foundation`).**
> El paquete Python publicado en PyPI sigue intacto en [`legacy/`](legacy/README.md) y es lo que
> usa hoy la gente. Este monorepo es la nueva base: contratos, infraestructura y, por fases,
> API Gateway y AI Worker. Ver [docs/architecture.md](docs/architecture.md).

## Qué hay aquí

| Carpeta | Contenido | Estado |
|---|---|---|
| [`packages/contracts`](packages/contracts) | Esquemas JSON (fuente de verdad) y los tipos TypeScript y modelos Pydantic generados | Hecho |
| [`docker-compose.yml`](docker-compose.yml) + [`docker/`](docker) | PostgreSQL, Redis, almacenamiento S3 y roles de mínimo privilegio | Hecho |
| [`tools/smoke`](tools/smoke) | Prueba de extremo a extremo Node → Redis → Python | Hecho |
| [`apps/api-gateway`](apps/api-gateway) | API NestJS 12 + Prisma 7: subida a S3, cola, estado, SSE, cancelación, descarga | Hecho (Fase 2) |
| `apps/ai-worker` | Worker Python (Whisper, ffmpeg) | Fase 3 |
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
`docker compose --profile app up -d --build` (y `docker compose ps` para ver la salud).

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
| `npm run compose:check` | Valida `docker-compose.yml` con y sin el perfil `app` |

## Decisiones

Los porqués están en [docs/adr/](docs/adr): contratos por esquema, `objectKey` en vez de URLs,
Python directo a PostgreSQL, almacenamiento S3 sin MinIO, reglas del worker y desarrollo local.

## Licencia

[MIT](LICENSE)
