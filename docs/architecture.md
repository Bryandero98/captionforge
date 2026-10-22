# Arquitectura

CaptionForge se separa en dos procesos que no comparten disco ni memoria: un **API Gateway** que
atiende a las personas usuarias y un **AI Worker** que hace el trabajo pesado (Whisper, ffmpeg,
traducción). Se hablan por una cola (Redis/BullMQ) y por un almacenamiento de objetos (S3); el
contrato de los mensajes vive en [`packages/contracts`](../packages/contracts).

```mermaid
flowchart LR
  U[Cliente web] -->|1. sube el video| API[API Gateway<br/>NestJS + Prisma]
  API -->|2. guarda jobs/ID/input.ext| S3[(Almacenamiento S3)]
  API -->|3. fila Job| PG[(PostgreSQL)]
  API -->|4. encola transcribe / burn| R[(Redis + BullMQ)]
  R -->|5. entrega el trabajo| W[AI Worker<br/>Python]
  W -->|6. lee y escribe artefactos| S3
  W -->|7. actualiza estado| PG
  W -.->|progreso| R
  API -.->|cancelación<br/>captionforge:cancel| R
  API -->|8. progreso y descargas| U
```

## Quién puede qué

| Actor | PostgreSQL | S3 | Redis |
|---|---|---|---|
| Superusuario del contenedor (`POSTGRES_USER`) | administración; solo lo ve la tarea `pg-roles` | cuenta root: solo la ve `s3-init` | — |
| Dueño del esquema (`cf_owner`, sin superusuario) | DDL; solo lo usa `prisma migrate deploy` (servicio `migrate`) | — | — |
| API Gateway (`cf_api`) | SELECT, INSERT, UPDATE, DELETE; sin DDL | leer, escribir (incl. multiparte) y borrar bajo `jobs/*` | encolar, escuchar eventos, publicar cancelaciones |
| AI Worker (`cf_worker`) | SELECT; UPDATE solo de columnas concretas de `Job` | leer y escribir bajo `jobs/*`; no borra | consumir, reportar progreso, escuchar cancelaciones |

Un rol comprometido no puede borrar tablas, ni leer otros usuarios de la base, ni salir de
`jobs/` en el bucket. [`docker/verify-infra.sh`](../docker/verify-infra.sh) lo comprueba.

## Contratos

Cada mensaje es un esquema JSON versionado (`*.v1.json`); de ahí se generan los tipos TypeScript
y los modelos Pydantic. Los archivos se nombran con `bucket` + `objectKey` (nunca con URLs, ver
[ADR 0002](adr/0002-object-key-en-lugar-de-url.md)).

| Mensaje | Sentido | Cola / canal |
|---|---|---|
| `transcribe-job` / `transcribe-result` | API → worker / worker → API | `captionforge.transcribe` |
| `burn-job` / `burn-result` | API → worker / worker → API | `captionforge.burn` |
| `job-progress` | worker → API | progreso del trabajo de BullMQ |
| `job-error` | worker → API | `failedReason` del trabajo |
| `cancel-message` | API → worker | canal Redis `captionforge:cancel` |

Reglas de la cola: el `jobId` del contrato es el `jobId` de BullMQ (encolar dos veces no
procesa dos veces), `attempts: 1` (un fallo se informa, no se repite en silencio) y el trabajo de
quemado lleva el `etag` de `segments.json` para detectar que los subtítulos cambiaron mientras
tanto (`SEGMENTS_CHANGED`).

## Reglas del worker

Detalladas y verificadas con BullMQ real en [ADR 0006](adr/0006-reglas-del-worker.md):

1. Whisper y ffmpeg corren **fuera del bucle de eventos** (hilo o subproceso); si no, el candado
   del trabajo no se renueva y BullMQ lo marca `stalled`.
2. La cancelación es cooperativa: llega por Redis pub/sub y se traduce en la señal de aborto del
   trabajo en curso.
3. Todo subproceso tiene tiempo máximo y se termina en un `try/finally` (heredado de la
   corrección del paquete `legacy`).
4. El payload se valida en modo estricto (sin coerciones) aunque el API ya lo haya validado.
5. Un solo trabajo pesado a la vez por proceso, aunque haya una cola por tipo (transcribir y
   quemar comparten el mismo hueco). Se escala con más réplicas, no con más concurrencia.
6. El estado del trabajo se escribe con transiciones condicionales (`UPDATE ... WHERE status = ...`):
   el API que cancela y el worker que toma el trabajo compiten con la misma condición y gana uno solo.
7. El quemado lee `segments.json` con `If-Match`: si los subtítulos se editaron después de pedir el
   quemado, falla con `SEGMENTS_CHANGED` en lugar de quemar algo que nadie aprobó.

8. El payload debe quedarse en su alcance aunque cumpla el contrato: `outputPrefix` es exactamente
   `jobs/<su id>/out/` y los buckets de entrada son el configurado; si no, `INTERNAL` sin tocar S3.

## Desarrollo local y despliegue

El compose declara los cinco servicios, pero `api-gateway` y `ai-worker` están en el perfil
`app`: en desarrollo se ejecutan nativos contra la infraestructura dockerizada
([ADR 0007](adr/0007-desarrollo-local-y-perfil-app.md)). Toda la infraestructura cabe en ~125 MB
de RAM.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Paquete actual a `legacy/`, PR #6 y #7 fusionados | Hecha |
| 1 | Monorepo, contratos, compose, roles mínimos, smoke test | Hecha |
| 2 | API Gateway NestJS + Prisma (incluye la migración que concede UPDATE por columna a `cf_worker`) | Hecha |
| 3 | AI Worker Python (modelo cargado una vez, reutiliza los módulos de `legacy`, [ADR 0009](adr/0009-worker-reutiliza-el-paquete-heredado.md)) | Hecha |
| 4a | Flujo de quemado: edición de subtítulos, cola `burn`, descarga con `Range` | Hecha |
| 4b | Cliente web (`apps/web`) servido por el API, vanilla JS sin build y SSE propio ([ADR 0012](adr/0012-frontend-vanilla-sse.md)): estática + CSP, subida con progreso/cancelación y cola de varios videos, seguimiento SSE, resultados y descargas, editor con control de versión (etag/409), quemado como trabajo propio, historial local y 6 idiomas (es/en revisados; pt/fr/de/it traducción automática pendiente de revisión nativa). Guía: [guia-de-uso.md](guia-de-uso.md) | Hecho |
| 5a | Endurecimiento: clave de API opcional, límites de uso, cierre de trabajos huérfanos, pool de conexiones ([ADR 0010](adr/0010-endurecimiento-del-api-y-trabajos-huerfanos.md)) | Hecha |
| 5b | Autenticación de personas usuarias, observabilidad (métricas, trazas) y despliegue | Pendiente |

## Seguimiento conocido (revisión independiente, 2026-10-21)

Rama `fix/security-h9-h10`: **corregidos** H9 (workflows con `permissions` global de solo lectura, acciones fijadas por SHA, publicación a PyPI por Trusted Publishing y Dependabot; lo comprueba `tools/check-workflows.mjs`) y H10 (guardia de `Host`, `Origin` y `Sec-Fetch-Site` y CORS de lista cerrada, [ADR 0011](adr/0011-origen-y-host-fail-closed-contra-paginas-ajenas.md)). Rama `fix/docker-fonts`: **corregido** F1 (la imagen del worker instala `fontconfig`, `fonts-liberation` —sustituta de Arial— y
`fonts-dejavu-core`; `check_image.py` quema un SRT y un ASS de karaoke y mira el fotograma, y comprueba que Arial resuelva a
Liberation Sans). Rama `fix/security-hardening`: **corregidos** H2 (memoria de las subidas: tope total y por cliente, ritmo mínimo,
partes de 5 MiB), H4 (tope y duración máxima de los flujos SSE), H7 (ffmpeg con entorno mínimo), el apagado
ordenado del worker y la limpieza de `/work` al arrancar (ver [ADR 0010](adr/0010-endurecimiento-del-api-y-trabajos-huerfanos.md)).
Siguen abiertos:

| Id | Riesgo | Qué falta |
|---|---|---|
| H7b | El entorno mínimo evita la herencia accidental de secretos, **no** un ffmpeg ya comprometido que corra con el mismo usuario (podría leer `/proc/<padre>/environ`) | Ejecutar ffmpeg con otro usuario, o en otro contenedor, con `no-new-privileges` y seccomp |
| H9b | H9 está corregido en workflows y publicación; las imágenes base siguen fijadas por etiqueta y no por resumen `sha256` | Fijar por resumen (ver [Límites declarados](architecture_and_security.md#límites-declarados)) |
| Pasos manuales | Registrar el publicador de confianza en PyPI, crear el entorno `pypi` con revisores y retirar `PYPI_API_TOKEN` | Mantenedor |

Además: el paquete `legacy` de PyPI conserva el riesgo que ya se corrigió en la imagen del worker (PyAV 19 con
faster-whisper 1.2.1 sin fijar: `av==18.1.0` en `apps/ai-worker/constraints.txt`).

H5 (lista HLS disfrazada de video) se investigó y **no es explotable** con ffmpeg 7.1: el worker guarda la entrada
como `input.bin` y la whitelist por defecto de un archivo local bloquea http; queda una prueba de regresión
(`apps/ai-worker/tests/test_ssrf.py`).
