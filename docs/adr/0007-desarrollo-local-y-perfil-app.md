# ADR 0007: Desarrollo local sin contenedores de aplicación (perfil `app`)

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
La máquina de desarrollo tiene poca RAM. El worker de IA (Whisper) y el API en contenedores,
sumados a Docker Desktop, la ahogan. A la vez, el despliegue debe quedar descrito por completo en
un único `docker-compose.yml`.

## Decisión
El compose declara los cinco servicios, pero `api-gateway` y `ai-worker` llevan
`profiles: ["app"]`:

- `docker compose up -d --wait` → solo infraestructura (PostgreSQL, Redis, S3 + su inicialización).
- `docker compose --profile app up -d --build --wait` → despliegue completo.

En desarrollo, el API y el worker se ejecutan **nativos** (`npm`, `python`) contra la infraestructura
dockerizada, que escucha solo en `127.0.0.1`. La infraestructura completa usa ~125 MB; además se
limita WSL2 a 3 GB (`.wslconfig`).

## Alternativas consideradas
- **Dos archivos compose** (uno de desarrollo y otro de producción): se desincronizan. Descartada:
  los perfiles dan lo mismo con un solo archivo.
- **Todo en contenedores también en local:** descartada por consumo de RAM.

## Consecuencias
- `docker compose config --profile app` se valida en CI aunque los Dockerfiles de las aplicaciones
  aún no existan (llegan con las fases 2 y 3); la construcción real se probará entonces.
- Las migraciones las ejecuta un servicio aparte, `migrate`, con la contraseña de `cf_owner`; el
  contenedor de la API solo conoce la de `cf_api`. En local, `prisma migrate deploy` se ejecuta con
  la URL de `cf_owner`.
- `npm run infra:up` levanta postgres, redis y s3 con `up -d --wait` y ejecuta las tareas de un solo
  uso (`pg-roles`, `s3-init`) con `run`: `up --wait` devuelve error si una tarea ya terminó.
