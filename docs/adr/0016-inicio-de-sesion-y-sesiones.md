# ADR 0016: Inicio de sesión con GitHub y Google, sesiones por cookie y gestión de claves

## Estado
Aceptada (issue [#7](https://github.com/Bryandero98/captionforge/issues/7), segunda pieza de la fase 5b). Completa el
[ADR 0015](0015-tenencia-y-claves-de-api.md) (el modelo `User` ya no está vacío) y cumple la previsión del
[ADR 0011](0011-origen-y-host-fail-closed-contra-paginas-ajenas.md) sobre cookies y CSRF. Supera el punto 5 del ADR 0015: el
rol `cf_api` ahora **crea** tenants, personas, sesiones y claves.

## Fecha
2026-10-22

## Contexto
Con el ADR 0015 cada trabajo tiene dueño, pero la única forma de ser alguien es tener una clave de API, y la clave por defecto
se entregaba a la interfaz en `/web-config.json`: quien alcanzara el puerto actuaba como ese tenant. Para ofrecer el servicio
a otras personas hace falta que se identifiquen, que cada una tenga su propio tenant y que pueda gestionar sus claves.

Restricciones: una persona = un tenant (el modelo admite Tenant 1:N User); un solo servidor; sin pagos; la instalación de
una sola persona (`start.sh`/`start.bat`) debe seguir funcionando sin registrarse en ningún proveedor.

## Decisión
1. **Flujo.** OAuth2 *authorization code* con **PKCE S256** y `state`, escrito con `fetch` (sin librería). GitHub (OAuth2,
   alcance `read:user user:email`, correo primario verificado) y Google (OIDC *userinfo*, `email_verified`). Una cookie
   `cf_oauth` (`state.verifier`, 600 s) se consume siempre, con éxito o sin él. Cada llamada al proveedor tiene tiempo máximo
   (10 s), tope de respuesta (256 KB) y `redirect: "error"`.
2. **Sesión.** Cookie `cf_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 días; `Secure` y prefijo `__Host-` cuando
   `PUBLIC_URL` es https. El valor es un token aleatorio de 256 bits; la base guarda solo su SHA-256 (`Session.tokenHash`).
   Cerrar sesión borra la fila.
3. **Anti-CSRF.** Tres capas: `SameSite=Lax`; la guardia de `Origin`/`Sec-Fetch-Site` del ADR 0011, que se mantiene; y la
   cabecera `X-Requested-With: captionforge`, obligatoria en los métodos que modifican cuando la identidad viene de la cookie
   (una página ajena no puede añadirla sin preflight, y el preflight lo rechaza la lista cerrada de orígenes). Sin token
   sincronizado: la cabecera propia da la misma garantía sin estado extra.
4. **Dos vías de identidad.** Primero la clave de API; si hay cabecera de clave, **solo cuenta la clave** (una clave inválida
   nunca cae a la cookie). Después la cookie. Las rutas `/auth/*` son públicas.
5. **Cuentas.** Primer inicio de sesión: se crean `Tenant` y `User` en una transacción (con manejo de la carrera por
   `P2002`). **No se fusionan cuentas de dos proveedores por coincidir el correo**: la segunda queda con `email` nulo. Un
   correo no es prueba de ser la misma persona entre proveedores y fusionar abre la toma de cuentas.
6. **Claves de API.** Se crean, listan y revocan solo con sesión (`403` con una clave de API: una clave no puede acuñar
   más claves). Tope de 20 activas por tenant. La clave completa se muestra una vez.
7. **Modo local.** `LOCAL_MODE` (por defecto `true`): `/web-config.json` entrega `DEFAULT_API_KEY` y la interfaz funciona sin
   iniciar sesión. Con `LOCAL_MODE=false` el inicio de sesión es obligatorio y la clave por defecto deja de entregarse.
8. **Privilegios (`cf_api`).** INSERT en `Tenant`, `User`, `ApiKey` y `Session`; SELECT; UPDATE solo de
   `ApiKey.lastUsedAt` y `revokedAt`; DELETE solo de `Session`. No borra tenants, personas ni claves. `cf_worker` no ve nada
   de tenencia ni de sesiones. Los mismos permisos viven en la migración y en `docker/postgres/init-roles.sql`, para
   sobrevivir a una re-ejecución del script de roles.

## Alternativas descartadas
- **openid-client / Passport.** Añaden una dependencia grande y una superficie de configuración para dos proveedores con
  endpoints fijos. El flujo son ~150 líneas verificables con un proveedor falso que implementa PKCE de verdad.
- **JWT sin estado como sesión.** No se puede revocar al cerrar sesión ni al detectar un robo sin una lista de bloqueo, que
  vuelve a ser estado. Una fila con hash es más simple y revocable.
- **Token anti-CSRF sincronizado.** Exige guardar y entregar otro secreto por sesión; la cabecera propia con la lista
  cerrada de orígenes protege igual.
- **Fusionar cuentas por correo.** Descartado por toma de cuentas (punto 5).
- **Seguridad a nivel de fila (RLS).** El aislamiento ya se aplica en cada consulta y se prueba contra la base real; RLS
  duplicaría el mecanismo sin cerrar nada que los privilegios mínimos no cierren.

## Consecuencias
- Hay que registrar una aplicación OAuth en cada proveedor y poner `PUBLIC_URL`, `GITHUB_CLIENT_ID/SECRET` y
  `GOOGLE_CLIENT_ID/SECRET` en el `.env`. Un proveedor se configura entero o no se configura.
- Un fallo del proveedor se traduce a un código de error genérico en `/?login_error=` (`denied`, `state`, `provider`,
  `unavailable`); nunca se refleja texto del proveedor.
- La interfaz decide al cargar cómo entra (`key`, `session`, `login`, `none`, `error`) y muestra la pantalla de entrada, la
  barra de cuenta o el panel de claves en consecuencia.
- Queda abierto, para el issue #8, el límite por tenant en Redis; y, para #9, las métricas de inicios de sesión.
