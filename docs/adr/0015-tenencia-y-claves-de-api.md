# ADR 0015: Tenencia y claves de API (cada trabajo tiene un dueño; otro tenant ve un 404)

## Estado
Aceptada (issue [#6](https://github.com/Bryandero98/captionforge/issues/6), primera pieza de la fase 5b). Sustituye la
`API_KEY` compartida del [ADR 0010](0010-endurecimiento-del-api-y-trabajos-huerfanos.md) y completa la nota «Propiedad» de
[architecture_and_security.md](../architecture_and_security.md). Las notas de `API_KEY` de los ADR 0011 y 0012 quedan superadas
por este documento.

## Fecha
2026-10-22

## Contexto
Hasta ahora los trabajos no tenían dueño: quien conociera un UUID podía leer, cancelar, editar y quemar. La `API_KEY` era una
clave compartida y opcional que, además, **bloqueaba la interfaz web** (un `<video src>` o un `EventSource` no mandan cabeceras).
Para ofrecer el servicio a más de una persona hace falta separar los datos de cada una, y que esa separación no dependa de que
cada ruta se acuerde de comprobarla.

Decisiones de la fase 5b que condicionan esto: una persona = un tenant (el modelo admite Tenant 1:N User), acceso con GitHub y
Google (issue #7, no aquí), un solo servidor, y cuotas solo como escudo operativo (issue #8).

## Decisión
1. **Modelo.** `Tenant`, `User` (aún sin uso: lo llenará el inicio de sesión del issue #7) y `ApiKey`. `Job.tenantId` es
   obligatorio. Todas las claves foráneas son `ON DELETE RESTRICT`: no se borra un tenant que tiene trabajos o claves.
2. **Claves de API.** `cfk_` + 256 bits aleatorios. La base guarda **solo el SHA-256** (`keyHash`, único) y los 8 primeros
   caracteres (`prefix`, para reconocerla en un listado); la clave completa se enseña una vez. Un hash rápido basta porque la
   clave no es una contraseña elegida por una persona: no hay diccionario que recorrer, y bcrypt/argon2 solo sumarían latencia
   a cada petición. La búsqueda es por igualdad sobre un índice único, así que no hay comparación de cadenas con tiempo
   dependiente de cuántos caracteres acertó quien llama.
3. **Guardián global** (`TenantAuthGuard`, `APP_GUARD`). Lee `X-API-Key` (o `Authorization: Bearer`), calcula el hash y busca la
   fila. Válida y no revocada: deja `request.tenantId`. Si no, `401` con `WWW-Authenticate`. Una caída de la base responde 500:
   cierra, no deja pasar. `/health` y `/v1/capabilities` (solo booleanos) son públicos. `lastUsedAt` se anota **sin esperar**
   (fire-and-forget) y como mucho una vez por minuto y clave.
4. **Aislamiento en la consulta, no después.** Toda operación de `JobsService` recibe el `tenantId` y lo pone en el `where`
   (`findFirst({ id, tenantId })`, `updateMany({ id, tenantId, ... })`). El decorador `@TenantId()` falla con 401 si falta, de modo que
   ninguna ruta puede olvidarlo en silencio. Un trabajo de otro tenant da **404, no 403**: un 403 confirmaría que el UUID existe.
   El quemado hereda el tenant de su transcripción. El recolector de huérfanos (`ReaperService`) es la única pieza que ve todos
   los tenants, a propósito. Nuevo `GET /v1/jobs` (paginado por cursor) lista solo los del tenant.
5. **Mínimo privilegio en la base.** `cf_api` solo **lee** `Tenant` y `ApiKey` y puede actualizar **únicamente**
   `ApiKey.lastUsedAt`; no crea ni borra tenants, claves ni personas, así que un API comprometido no puede darse acceso. `cf_worker` no
   ve la tenencia. Crear claves es cosa del dueño del esquema (`cf_owner`): la semilla y, más adelante, el inicio de sesión.
6. **Migración sobre una base con datos** (`20261022000000_tenancy`): la columna nace **nula**, se crea el tenant «Default» (id fijo
   `00000000-0000-4000-8000-000000000001`), se asignan los trabajos existentes, se conceden los permisos y **solo entonces** pasa a
   `NOT NULL`. Con `ADD COLUMN ... NOT NULL` directo fallaría en cualquier instalación con trabajos (`migration-tenancy.spec.ts`
   lo demuestra en rojo y luego en verde). Se escribió a partir de `prisma migrate diff`, porque `cf_owner` (sin `CREATEDB`, por
   mínimo privilegio) no puede crear la *shadow database* que exige `migrate dev`.
7. **Semilla** (`dist/tenancy/seed.js`, corre en el servicio `migrate` tras `prisma migrate deploy`): da de alta, con el dueño, la
   clave `DEFAULT_API_KEY` del `.env` en el tenant «Default». Es idempotente; cambiar la variable **rota** la clave (la anterior llamada
   «default» queda revocada). `start.sh` y `start.bat` la generan (y la añaden a un `.env` anterior).
8. **Interfaz web (MVP).** Sin inicio de sesión todavía, el servidor entrega la clave por defecto a la propia interfaz en
   `GET /web-config.json` (solo si existe `WEB_API_KEY`, que compose rellena con `DEFAULT_API_KEY`). La guardia de Host/Origin/
   `Sec-Fetch-Site` corre antes, así que una página ajena no puede leerla desde el navegador. Una clave guardada en
   `localStorage["cf-api-key"]` tiene prioridad. La clave va en `X-API-Key` en `fetch`, `XMLHttpRequest` y el flujo SSE (que ya era
   `fetch`, ADR 0012).
9. **Descargas.** Un `<a href>` y un `<video src>` no mandan cabeceras: el `.srt` y el video se piden con `fetch` y se entregan como
   `Blob`. La CSP añade `blob:` a `media-src`. Límite conocido: el `Blob` vive en memoria, por eso la **vista previa** del video se
   omite por encima de 256 MiB (la descarga sigue). Un enlace firmado de corta vida lo resolvería (pendiente).

## Alternativas descartadas
- **Filtrar con un middleware o un `where` global de Prisma:** esconde el filtro y hace fácil saltárselo en una consulta nueva. Se
  prefirió que el tenant sea un argumento obligatorio del servicio.
- **Row-Level Security de PostgreSQL:** protege aunque el código falle, pero exige fijar el tenant por conexión (`SET LOCAL`) con
  un pool compartido y cambia el modelo de roles. Queda como defensa en profundidad para el issue #8 si hace falta.
- **403 para recursos ajenos:** revela que existen.
- **bcrypt/argon2 para las claves:** latencia por petición sin ganancia con 256 bits de entropía.
- **Enlaces firmados para video/SRT ya en este PR:** más superficie (secreto de firma, caducidad, repetición) para un MVP local.

## Consecuencias
- Toda petición a `/v1/jobs` necesita clave; los clientes externos añaden `-H "X-API-Key: <clave>"`.
- Quien alcance el puerto de una instalación local obtiene la clave del tenant «Default» en `/web-config.json`, igual que antes podía
  usar el API abierto en `127.0.0.1`. Es aceptable en local (el puerto solo se publica en `127.0.0.1`) y deja de serlo al exponer el
  servicio: el issue #7 elimina esta vía.
- Las pruebas crean sus propios tenants con el rol dueño (`test/support/tenancy.ts`) y `fetch` los autentica solo; lo que se prueba
  de forma explícita es el aislamiento (`tenancy.e2e.spec.ts`), los permisos (`db-privileges.spec.ts`), la migración
  (`migration-tenancy.spec.ts`) y la semilla (`seed.spec.ts`).
- El nombre y el almacenamiento de objetos S3 siguen siendo `jobs/<id>/...` sin prefijo de tenant: el acceso a S3 solo lo hace el API
  tras comprobar el trabajo. Un prefijo por tenant sería un cambio de contrato con el worker, fuera de este issue.
