# ADR 0008: API Gateway con NestJS 12, Fastify y Prisma 7 (ESM)

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
El API recibe videos de hasta 4 GiB, los guarda en S3, registra el trabajo en PostgreSQL y lo
encola. Debe funcionar con el reparto de roles de [ADR 0003](0003-python-directo-a-postgres-y-prisma-fuente-del-esquema.md).

## Decisión
- **NestJS 12 con Fastify.** Nest 12 es solo ESM, así que todo el paquete es ESM
  (`"type": "module"`, imports relativos con `.js`). Fastify + `@fastify/multipart` permite
  recibir el archivo como un flujo.
- **La subida no toca el disco ni la memoria.** El flujo multipart pasa por un contador de bytes
  (límite `MAX_UPLOAD_BYTES`, 413 al superarlo) y se envía a S3 con subida multiparte
  (`@aws-sdk/lib-storage`). Si algo falla se borra lo subido. El campo `options` debe ir antes
  que `file`.
- **Prisma 7 con el adaptador `pg`** y cliente generado en `src/generated` (no se versiona; se
  genera en la construcción). Se usa la versión `7.10.1`: la etiqueta `latest` del CLI apunta a un
  candidato a versión 8. Las migraciones las ejecuta `cf_owner` (servicio `migrate`); la API en
  ejecución solo conoce `cf_api`.
- **La migración inicial concede los permisos del worker** (UPDATE por columna de `Job`) y
  revoca el acceso a `_prisma_migrations`, con guardas por si los roles no existen. Un test de
  privilegios sobre la base real vigila los dos lados.
- **Todo mensaje a la cola se valida con el contrato** (Ajv sobre los mismos esquemas que usa
  Pydantic) antes de encolar, y el `jobId` del contrato es el id de BullMQ.
- **Eventos por SSE consultando la base cada segundo**, no por `QueueEvents`: el estado durable
  lo escribe el worker en PostgreSQL y esa es la fuente de verdad, así un reinicio del API no
  pierde nada. Latido cada 15 s para que los proxies no corten el flujo.
- **TypeScript 6.0** (el que usa Nest CLI 12), no 7.

## Alternativas consideradas
- **Express:** más lento y obliga a middleware para multipart; sin ventaja aquí.
- **Escribir el archivo en disco y luego subirlo:** duplica el tiempo y exige espacio libre igual
  al tamaño del video.
- **URL prefirmada para que el navegador suba directo a S3:** quita carga al API, pero contradice
  [ADR 0002](0002-object-key-en-lugar-de-url.md) y pierde el control del límite de tamaño y del
  tipo antes de guardar. Se puede reconsiderar si el API se vuelve cuello de botella.

## Consecuencias
- **Todavía no hay autenticación ni límite de peticiones**: el API escucha por defecto solo en
  `127.0.0.1` y debe tenerlos antes de exponerse (Fase 5).
- El sondeo de SSE cuesta una consulta por segundo y cliente; suficiente a esta escala.
- La imagen del API incluye el CLI de Prisma porque el servicio `migrate` usa la misma imagen.
- Descubierto por las pruebas: volver a ejecutar `pg-roles` (rotar contraseñas) devolvía a `cf_api`
  y `cf_worker` el acceso a `_prisma_migrations`; ahora `init-roles.sql` lo vuelve a revocar y la CI
  lo comprueba.
- Descubierto al construir: el healthcheck de PostgreSQL debe probar TCP (`-h 127.0.0.1`); durante
  la inicialización, el servidor temporal responde por socket y `pg-roles` fallaba con
  *Connection refused* en el primer arranque.
