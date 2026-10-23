# ADR 0020: IA avanzada (traducir y doblar) y claves externas propias (BYOK)

## Estado
**Propuesta** (issue [#11](https://github.com/Bryandero98/captionforge/issues/11)). El Tech Lead aprobó el plan y las siete decisiones de
abajo; el ADR pasa a «Aceptada» al cerrar el issue (tarea T12). Plan y tareas: `tasks/plan.md` y `tasks/todo.md`.
Se apoya en el [ADR 0003](0003-python-directo-a-postgres-y-prisma-fuente-del-esquema.md) (el worker habla con PostgreSQL con permisos
por columna), el [ADR 0015](0015-tenencia-y-claves-de-api.md) (tenencia) y el [ADR 0019](0019-equipos-membresias-roles-e-invitaciones.md) (roles).

## Fecha
2026-10-23

## Contexto
Se añaden dos módulos de IA que dependen de proveedores externos: **traducir** los subtítulos y **doblar** (texto a voz). Para no gastar
VRAM propia ni cobrar el cómputo, cada espacio de trabajo aporta sus propias claves (BYOK, *bring your own key*). Una clave de proveedor
es dinero de otra persona: no puede quedar en claro en la base, ni viajar por Redis (que aquí no va cifrado en memoria), ni aparecer en un
registro o en un mensaje de error.

## Decisiones confirmadas por el Tech Lead
1. **Secreto del canal interno: `WORKER_INTERNAL_TOKEN` dedicado.** No se reutiliza `DEFAULT_API_KEY`, que es una clave de *espacio*
   con permisos de espacio (menor privilegio).
2. **Canal interno: un listener en un puerto interno propio**, que no se publica en el anfitrión ni pasa por Caddy.
3. **Proveedores de v1:** OpenAI (traducción y voz), ElevenLabs (voz) y Argos local (traducción, sin clave).
4. **Salida del doblaje:** `dub.mp3` y, opcionalmente, un MP4 con el audio mezclado (`replace` o `duck`).
5. **Gestión de claves: solo el Dueño.** El Editor las *usa* al lanzar trabajos; el Lector no lanza trabajos. Las claves de API del
   espacio (rol Editor estático) tampoco las ven ni las gestionan.
6. **Rotación de `APP_SECRET` aplazada:** el esquema lleva `keyVersion`, pero el comando de re-cifrado con `APP_SECRET_PREVIOUS` queda
   para un issue futuro.
7. **Topes de gasto por trabajo:** 50 000 caracteres y 1 000 segmentos por defecto.

## Decisión
1. **Trabajos hijos de una transcripción terminada**, como el quemado: `TRANSLATE` y `DUB` (nuevos valores de `JobKind`), con su cola.
2. **Tabla `TenantExternalKey`** `(id, tenantId, provider, ciphertext, keyVersion, last4, createdBy, createdAt, rotatedAt)`, única por
   `(tenantId, provider)`. `cf_api` tiene `SELECT`/`INSERT`/`UPDATE`/`DELETE`; **`cf_worker` no tiene ningún permiso** sobre ella: la base
   misma impide que el worker lea el cifrado. Una prueba de privilegios lo fija.
3. **Cifrado en reposo:** AES-256-GCM, IV aleatorio de 96 bits por cifrado, etiqueta de 128 bits. La clave de cifrado se *deriva* de
   `APP_SECRET` con HKDF-SHA256 (contexto `captionforge/external-key/v1`); el secreto crudo no se usa como clave. El **dato autenticado
   adicional (AAD)** es `tenantId|provider|keyVersion`: un cifrado copiado a otra fila (otro espacio u otro proveedor) no descifra.
   Formato guardado: `v1.<iv>.<etiqueta>.<datos>` en base64url.
4. **`APP_SECRET`:** un secreto **aleatorio** (hexadecimal de 64 caracteres, o base64/base64url de 43 o más) de 32 bytes o más y con al
   menos 12 símbolos distintos: HKDF no estira un secreto débil y, con un volcado de la base, una frase se podría probar sin conexión.
   Si está definido y no cumple, el API **no arranca** (el mensaje nunca repite el valor). Si no está definido, la función BYOK queda
   **apagada** (`capabilities.byok.enabled = false`, las rutas de claves responden 404) y se registra un aviso; nunca se cifra con un valor
   por defecto. Perderlo equivale a perder las claves guardadas: la persona las vuelve a pegar.
5. **API de gestión** (`/v1/workspaces/current/external-keys`): solo Dueño y solo con sesión; `Cache-Control: no-store`; las lecturas
   devuelven proveedor, `last4` y fechas, **jamás** la clave. Borrar elimina la fila. Reemplazar la clave no cambia `createdBy` (quién la
   guardó primero; `cf_api` ni siquiera puede actualizarlo): quién la reemplazó queda en el registro. Una clave tiene 20 o más caracteres
   (así los 4 que se muestran no son más de la quinta parte).
6. **Entrega al worker (Fase 2):** `POST /internal/v1/jobs/:jobId/external-key` en el listener interno. El espacio sale de la fila del
   trabajo (nunca del cuerpo); el trabajo debe estar `RUNNING`, ser `TRANSLATE`/`DUB` y pedir el proveedor que declara en sus opciones.
7. **Cero fugas en Redis:** el payload de BullMQ lleva solo el proveedor y las opciones. Una prueba «canario» busca una clave de mentira en
   Redis, la base, los registros y `/work`.
8. **Degradación elegante (Fase 3):** códigos `EXTERNAL_*` en el contrato de errores; sin reintentos para 401/402/403; 429 y 5xx con espera
   y tope; los mensajes del proveedor no se reenvían (pueden contener fragmentos de la clave).
9. **Control del gasto:** tope de caracteres y segmentos por trabajo, estimación y confirmación en la interfaz, sin URL base
   personalizada del proveedor (SSRF y envío de la clave a un servidor ajeno).

## Cuestión abierta
- **Modo local (`LOCAL_MODE=true`)**: la interfaz entra con la clave de API por defecto, que es un actor de espacio y no una persona; como
  gestionar claves externas exige ser Dueño con sesión, en una instalación de una sola persona sin inicio de sesión la función BYOK no
  sería gestionable. Opciones: exigir inicio de sesión para BYOK (propuesta), o permitir gestionar con la clave por defecto en modo
  local. Pendiente de decisión del Tech Lead antes de la Fase 4 (interfaz).

## Alternativas descartadas
- **La clave dentro del payload del trabajo:** Redis sin cifrado en memoria. Descartada.
- **El worker descifra leyendo la tabla:** daría a `cf_worker` el cifrado y `APP_SECRET`. Descartada.
- **`DEFAULT_API_KEY` como secreto del canal interno:** permisos de espacio, no de servicio. Descartada.
- **Ruta `/internal` en el puerto público bloqueada en Caddy:** depende de una regla del proxy; el listener aparte no tiene esa dependencia.
- **Usar `APP_SECRET` directamente como clave AES:** sin separación de contextos ni versión. Se deriva con HKDF.

## Consecuencias
- Variables nuevas: `APP_SECRET` (Fase 1) y `WORKER_INTERNAL_TOKEN`, `INTERNAL_PORT`, `API_INTERNAL_URL` (Fase 2).
- Migración aditiva: sin `APP_SECRET` la función se apaga y el resto del producto no cambia.

## Riesgos (pre-mortem) y cómo se cubren
| Riesgo | Cobertura |
|---|---|
| Volcado de la base y `APP_SECRET` filtrados | HKDF + AAD; `APP_SECRET` fuera de la base y de los respaldos; `cf_worker` sin acceso a la tabla |
| Clave filtrada por un error del proveedor o del SDK | No se reenvían mensajes del proveedor; filtro de la clave en toda salida; prueba canario |
| Cifrado movido a otra fila | AAD con `tenantId`, `provider` y `keyVersion` |
| `APP_SECRET` débil (una frase) | Formato aleatorio y diversidad mínima validados al arrancar |
| Dos PUT a la vez del mismo proveedor | `upsert` nativo (`INSERT … ON CONFLICT`) sobre el único `(tenantId, provider)`; probado con 6 PUT simultáneos |
| Un Editor o una clave de API gestiona claves | Solo Dueño con sesión; matriz de roles en las pruebas |
| Respuesta cacheada con una clave | `Cache-Control: no-store` y la clave nunca va en una respuesta de lectura |
