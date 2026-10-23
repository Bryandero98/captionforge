# ADR 0019: Equipos: membresías, roles (Dueño, Editor, Lector) e invitaciones

## Estado
**Propuesta** (issue [#10](https://github.com/Bryandero98/captionforge/issues/10)). Pendiente de aprobación del Tech Lead antes de escribir código.
Evoluciona el modelo Tenant 1:N User de los [ADR 0015](0015-tenencia-y-claves-de-api.md) y [0016](0016-inicio-de-sesion-y-sesiones.md).

## Fecha
2026-10-23

## Contexto
Hoy una persona es dueña de un tenant y nadie más entra. Para equipos (B2B) varias personas deben compartir un espacio de trabajo con
permisos distintos, sin romper el aislamiento entre espacios ni las claves de API existentes.

## Decisión propuesta
1. **Tabla `Membership`** `(userId, tenantId, role, createdAt)` con clave primaria `(userId, tenantId)`. Roles: `OWNER` (Dueño),
   `EDITOR`, `VIEWER` (Lector). `Tenant` pasa a ser el *espacio de trabajo*; una persona puede pertenecer a varios.
2. **Permisos** (fail-closed por método HTTP, con excepciones declaradas):

   | Acción | Lector | Editor | Dueño |
   |---|---|---|---|
   | Ver trabajos, resultados y descargas | sí | sí | sí |
   | Subir, cancelar, editar subtítulos, quemar | no | sí | sí |
   | Crear y revocar claves de API | no | no | sí |
   | Invitar, cambiar roles, quitar miembros | no | no | sí |

   Una guardia de roles exige `VIEWER` en métodos seguros y `EDITOR` en los demás; lo que pida más lo declara con `@MinRole("OWNER")`.
   Una prueba recorre la tabla de rutas y falla si una ruta que modifica no tiene rol declarado.
3. **Espacio activo.** La sesión lleva `Session.tenantId` (nulo = el primer espacio de la persona). `PUT /v1/workspaces/active` lo cambia solo
   a un espacio donde la persona es miembro. Las claves de API siguen atadas a **un** tenant y actúan como `EDITOR`.
4. **Invitaciones.** `Invitation(id, tenantId, role, tokenHash, email?, invitedBy, expiresAt, acceptedAt?, revokedAt?)`. Sin servicio de
   correo: el Dueño copia un **enlace** de un solo uso (token de 256 bits, solo se guarda su SHA-256, vence en 7 días). Quien lo abre inicia
   sesión y lo acepta. Un `email` opcional restringe quién puede aceptar. No se puede invitar como `OWNER` (se promueve después).
5. **Último Dueño.** No se puede quitar ni degradar al último `OWNER` de un espacio (comprobado en transacción con bloqueo de filas).
6. **Migración en dos tiempos (expandir y contraer).** Esta entrega añade `Membership` y `Invitation`, rellena una membresía `OWNER` por
   cada `User.tenantId` existente y deja `User.tenantId` como «espacio personal» sin tocar. Quitar la columna es una migración posterior.
   Se prueba con datos reales previos a la migración (como `migration-tenancy.spec.ts`).
7. **Privilegios de `cf_api`:** `Membership` SELECT/INSERT/UPDATE(`role`)/DELETE; `Invitation` SELECT/INSERT/UPDATE(`acceptedAt`, `revokedAt`);
   `Session` UPDATE(`tenantId`). Mismo bloque en la migración y en `init-roles.sql`.
8. **Auditoría mínima.** `Job.createdByUserId` (nulo para claves de API): quién subió qué. No se registra nada más.
9. **Cuotas.** Siguen siendo por espacio de trabajo (ADR 0017): el equipo comparte el cupo.

## Alternativas descartadas
- **Un tenant por persona y compartir trabajos entre tenants.** Rompe el aislamiento probado (404 entre tenants) y complica cada consulta.
- **Roles como lista de permisos sueltos.** Más flexible, mucho más difícil de auditar; tres roles cubren el caso B2B inicial.
- **Invitar por correo desde el servidor.** Exige SMTP, reputación de dominio y un buzón de rebotes; el enlace copiable es suficiente para v1.
- **Quitar `User.tenantId` ya.** Una migración destructiva sin camino de vuelta; se contrae en una entrega aparte.

## Riesgos (pre-mortem)
1. **Escalada de privilegios** por una ruta sin rol declarado → la prueba de la tabla de rutas y la guardia fail-closed por método.
2. **Enlace de invitación filtrado** → un solo uso, vence, se puede revocar, y el `email` opcional lo ata a una persona.
3. **Cambiar de espacio con una sesión robada** → `Session.tenantId` solo acepta espacios donde hay membresía, comprobado en cada petición.
4. **Dejar un espacio sin Dueño** → regla del último Dueño, con prueba de concurrencia.

## Decisiones que necesito del Tech Lead
- ¿El Lector puede **descargar** videos y subtítulos (propuesto: sí) o solo ver el estado?
- ¿Las claves de API actúan como `EDITOR` (propuesto) o heredan el rol de quien las creó?
- ¿Invitación por enlace de un solo uso (propuesto) o se exige correo verificado coincidente?
