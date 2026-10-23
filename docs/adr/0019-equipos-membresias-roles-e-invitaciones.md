# ADR 0019: Equipos: membresías, roles (Dueño, Editor, Lector) e invitaciones

## Estado
**Aceptada** (issue [#10](https://github.com/Bryandero98/captionforge/issues/10)). El Tech Lead aprobó las cuatro decisiones de abajo y,
después, el SQL de la migración y la guardia de roles.
Evoluciona el modelo Tenant 1:N User de los [ADR 0015](0015-tenencia-y-claves-de-api.md) y [0016](0016-inicio-de-sesion-y-sesiones.md).

## Fecha
2026-10-23

## Contexto
Hoy una persona es dueña de un tenant y nadie más entra. Para equipos (B2B) varias personas deben compartir un espacio de trabajo con
permisos distintos, sin romper el aislamiento entre espacios ni las claves de API existentes.

## Decisiones confirmadas por el Tech Lead
1. **El Lector puede descargar** videos y subtítulos (ver y descargar; no subir ni editar).
2. **Las claves de API actúan con el rol estático `EDITOR`**, no heredan el de quien las creó.
3. **Invitación por enlace mágico de un solo uso**, vigencia de 7 días, **sin verificación de correo**.
4. **Regla del Último Dueño:** no se puede quitar ni degradar al único `OWNER` de un espacio.
5. **Una invitación nunca se consume sola** (revisión del Tech Lead tras la auditoría): quien abre un enlace, tenga o no sesión, ve
   «¿Deseas unirte a este espacio?» con el nombre del espacio y el rol, y `accept` solo se llama tras un clic explícito en «Unirme».

## Decisión
1. **Tabla `Membership`** `(userId, tenantId, role, createdAt)`, clave primaria `(userId, tenantId)`. Roles `OWNER` (Dueño), `EDITOR`,
   `VIEWER` (Lector). `Tenant` pasa a ser el *espacio de trabajo*; una persona puede pertenecer a varios.
2. **Permisos**, fail-closed por método HTTP con excepciones declaradas:

   | Acción | Lector | Editor | Dueño |
   |---|---|---|---|
   | Ver trabajos, resultados y descargas | sí | sí | sí |
   | Subir, cancelar, editar subtítulos, quemar | no | sí | sí |
   | Crear y revocar claves de API | no | no | sí |
   | Invitar, cambiar roles, quitar miembros | no | no | sí |

   `RolesGuard` (tras `TenantAuthGuard`) exige `VIEWER` en métodos seguros (`GET`, `HEAD`, `OPTIONS`) y `EDITOR` en los demás; lo que pida
   más lo declara con `@MinRole("OWNER")`. Sin sesión ni clave, o con un rol desconocido, deniega. El rechazo es `403` con
   `code: "role_forbidden"` (el cliente web lo distingue de un `403` genérico). Una prueba paramétrica recorre la tabla de rutas y falla si
   una ruta que modifica queda sin rol declarado.
3. **Espacio activo.** `Session.tenantId` es opcional: si falta, o la persona ya no es miembro, se usa su primera membresía; sin
   membresías, `401`. `POST /v1/me/workspace` `{tenantId}` lo cambia solo a un espacio donde hay membresía (`404` si no). `GET /v1/workspaces`
   lista los espacios con el rol y cuál está activo.
4. **Invitaciones** (`Invitation`: `id, tenantId, role, tokenHash, createdBy, createdAt, expiresAt, acceptedAt?, acceptedBy?, revokedAt?`).
   - `POST /v1/workspaces/invites` (Dueño) `{role}` → `201` con el enlace `…/?invite=cfi_…`. El token son 256 bits (`cfi_` + 43 caracteres
     base64url); en la base solo está su SHA-256, así que el enlace se ve **una sola vez**. No se puede invitar como `OWNER` (`400`).
     Máximo 50 pendientes por espacio (`409`).
   - `GET /v1/workspaces/invites/:token` (vista previa; solo sesión): devuelve `{tenant:{id,name}, role}` **sin consumir nada**, con los mismos
     `404`/`410`. Es lo que alimenta la pantalla de confirmación.
   - `POST /v1/workspaces/invites/:token/accept` (cualquier sesión; `401` sin ella). El consumo es un `updateMany` condicional atómico
     (`acceptedAt` y `revokedAt` nulos, `expiresAt` futuro): de dos aceptaciones simultáneas gana una. Token inexistente → `404`; usado,
     vencido o revocado → `410`. Aceptar **sube** de rango, nunca baja (quien ya es Dueño no pasa a Lector por abrir un enlace).
     Es **idempotente para quien ya la usó** (respuesta perdida, dos pestañas): devuelve el mismo resultado en vez de `410`. La membresía se
     crea con `INSERT … ON CONFLICT DO NOTHING`, así que dos invitaciones del mismo espacio aceptadas a la vez no chocan (sin `500`).
   - `GET /v1/workspaces/invites` y `DELETE /v1/workspaces/invites/:id` (revocar) para el Dueño.
5. **Miembros.** `GET /v1/workspaces/members`, `PUT /v1/workspaces/members/:userId` `{role}` y `DELETE …` (Dueño). El cambio y el borrado
   se hacen en una transacción que bloquea (`SELECT … FOR UPDATE`) las filas `OWNER` del espacio ordenadas por `userId`, y recién entonces
   cuenta: dos peticiones simultáneas no pueden dejar el espacio sin Dueño, ni se interbloquean entre sí. Los cambios usan `updateMany`/`deleteMany` (si otra petición ya quitó a
   la persona, `404` y no `500`). Al degradar o quitar a un Dueño se **revocan sus invitaciones sin usar** en la misma transacción: un
   enlace no sobrevive a quien lo creó. No se puede quitar a alguien su **único** espacio (`last_membership`): quedaría sin ninguna
   membresía y con un `401` permanente. Quien es quitado no necesita que se
   toquen sus sesiones: el espacio activo se comprueba en cada petición y, sin membresía, la sesión vuelve a su primer espacio.
6. **Migración en dos tiempos (expandir y contraer).** `20261024000000_memberships` crea `Membership`, rellena una membresía `OWNER` por cada
   `User.tenantId` y deja `User.tenantId` como «espacio personal» sin tocar; `20261025000000_invitations` añade `Invitation`. Quitar la
   columna es una migración posterior. `cf_owner` no puede `migrate dev`: el SQL sale de `prisma migrate diff` más relleno y permisos a mano.
   Hay una prueba con datos anteriores a la migración (`migration-membership.spec.ts`).
7. **Privilegios de `cf_api`** (mismo bloque en las migraciones y en `docker/postgres/init-roles.sql`; `cf_worker` no tiene acceso):
   `Membership` SELECT/INSERT/UPDATE(`role`)/DELETE; `Invitation` SELECT/INSERT/UPDATE(`acceptedAt`, `acceptedBy`, `revokedAt`);
   `Session` UPDATE(`tenantId`). `db-privileges.spec.ts` los comprueba contra la base real.
8. **Cuotas.** Siguen siendo por espacio de trabajo (ADR 0017): el equipo comparte el cupo.
9. **Códigos estables en los `409`:** `last_owner`, `invite_limit` (tope de 50) y `last_membership`, como `role_forbidden` en el `403`. La
   interfaz decide el texto por el código, nunca por el mensaje.
10. **Los tokens no llegan a los registros.** La aplicación registra el patrón de ruta, no la URL; **Caddy** (que sí registra la URI) censura
    `invite`, `code` y `state` del query y el token de `/v1/workspaces/invites/<token>[/accept]`. El paso de CI del perímetro lo comprueba.
11. **Cliente web.** El selector de espacio aparece con dos o más espacios; la sección «Equipo» (miembros, roles, invitaciones) y las
   «Claves de API» solo las ve el Dueño; el Lector ve una nota y no tiene formulario de subida. El enlace de invitación se guarda en
   `localStorage` (`cf_invite`) y se quita de la barra de direcciones al llegar (antes de guardar), sobrevive al viaje de inicio de sesión
   con el proveedor y, al volver, abre un `<dialog>` modal de confirmación (espacio, rol, «Unirme» / «Ahora no»). El token se borra cuando ya
   no sirve (404/410/400, o tras unirse) y se **conserva** ante un fallo pasajero (red, 5xx, 429) para poder reintentar. Si aceptar sale bien
   pero abrir el espacio falla, se dice que ya es miembro. Se oculta lo que el rol no puede usar, pero la autoridad es siempre el servidor.
   Sin almacenamiento (modo privado) el enlace vale en esa carga pero no sobrevive al inicio de sesión: hay que abrirlo otra vez.

## Aplazado respecto a la propuesta inicial
- **Restringir una invitación a un correo.** Descartado por la decisión 3: sin verificación de correo, un campo `email` daría falsa seguridad.
  El enlace es un secreto portador; se mitiga con un solo uso, vencimiento y revocación.
- **`Job.createdByUserId` (quién subió qué).** No entra en esta entrega: no lo pide ningún permiso y añadir la columna sin usarla
  amplía la superficie. Se retoma si hace falta auditoría.

## Alternativas descartadas
- **Un tenant por persona y compartir trabajos entre tenants.** Rompe el aislamiento probado (404 entre tenants) y complica cada consulta.
- **Roles como lista de permisos sueltos.** Más flexible, mucho más difícil de auditar; tres roles cubren el caso B2B inicial.
- **Invitar por correo desde el servidor.** Exige SMTP, reputación de dominio y un buzón de rebotes; el enlace copiable basta para v1.
- **Quitar `User.tenantId` ya.** Una migración destructiva sin camino de vuelta; se contrae en una entrega aparte.

## Riesgos (pre-mortem) y cómo se cubren
1. **Escalada de privilegios** por una ruta sin rol declarado → guardia fail-closed por método y la prueba paramétrica de la tabla de rutas.
2. **Enlace de invitación filtrado** → un solo uso atómico, vence en 7 días, se puede revocar, tope de 50 pendientes, censurado en los
   registros de Caddy, y se revoca solo si su creador deja de ser Dueño. Quien lo obtiene antes que la persona invitada se une con el rol
   ofrecido: es el costo de no verificar correo (decisión 3); el Dueño ve y revoca lo pendiente.
2b. **Enlace plantado** (alguien con sesión abre el enlace de un atacante y termina trabajando en el espacio ajeno) → la decisión 5: nada se
   consume ni se cambia de espacio sin un clic explícito sobre una pantalla que nombra el espacio.
3. **Cambiar de espacio con una sesión robada** → `POST /v1/me/workspace` solo acepta espacios con membresía, y se vuelve a comprobar en
   cada petición.
4. **Dejar un espacio sin Dueño** → regla del Último Dueño con bloqueo de filas; una prueba **determinista** sostiene la fila de otro Dueño
   bloqueada y comprueba que el cambio espera y cuenta bien (sin `FOR UPDATE` falla), más pruebas de carrera.
5. **Persona sin ningún espacio** → `last_membership` impide quitarle el único.
