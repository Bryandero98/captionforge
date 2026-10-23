# ADR 0011: Origen y Host cerrados por defecto frente a páginas web ajenas

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
La revisión de seguridad dejó abierto H10: «CSRF y DNS rebinding contra un API local sin `API_KEY`». El API
(NestJS sobre Fastify) escucha en `127.0.0.1:3000` y, sin `API_KEY`, acepta a cualquiera que llegue al puerto.
En un equipo de desarrollo «cualquiera» incluye a **cualquier página web abierta en el navegador**:

1. **Escritura ciega por petición simple.** Un `POST multipart/form-data` cross-origin es una petición
   *simple* para CORS: el navegador la envía sin preflight. Una página ajena puede crear trabajos (CPU durante
   horas), cancelarlos, editar subtítulos o pedir quemados. No lee la respuesta, pero el daño ya está hecho.
2. **DNS rebinding.** Un dominio del atacante que, tras unos segundos, resuelve a `127.0.0.1` hace que el
   navegador lo trate como *mismo origen* que el API, y entonces sí lee las respuestas (trabajos, subtítulos,
   descargas).

El API **no usa cookies ni sesiones**: se autentica, si acaso, con `Authorization: Bearer` o `X-API-Key`, que
ninguna página puede añadir sola a una petición cross-origin sin pasar por un preflight que el API rechaza.

## Decisión
**No se implementan tokens anti-CSRF.** Un token anti-CSRF defiende las credenciales que el navegador envía por
su cuenta (cookies, autenticación HTTP); aquí no hay ninguna, así que el token protegería una puerta que no
existe y añadiría estado al API. En su lugar, una guardia **fail-closed** con tres comprobaciones y CORS de lista
cerrada (`apps/api-gateway/src/security/request-guard.ts`, gancho `onRequest` de Fastify):

1. **`Host` en `ALLOWED_HOSTS`** (por defecto `localhost`, `127.0.0.1`, `[::1]`; sin puerto ni comodines).
   Cualquier otro, o una cabecera malformada o ausente, recibe **421**. Frena el DNS rebinding: el navegador
   envía el nombre del atacante como `Host`.
2. **`Origin` en `ALLOWED_ORIGINS`** (por defecto vacío) **o igual al propio origen del API**; si no, **403**, con
   cualquier método. `Origin: null` (iframes con sandbox, archivos locales) se rechaza. Un navegador siempre
   envía `Origin` en un POST o PUT y una página no puede falsificarlo; los clientes que no son navegadores (curl,
   otros servicios) no lo envían y no se ven afectados.
3. **`Sec-Fetch-Site`**: sin `Origin`, un método que modifica con `cross-site` o `same-site` recibe **403**. Es la
   segunda línea por si algún cliente omite `Origin`. Las lecturas (`GET`, `HEAD`) no se bloquean por esta señal:
   un enlace de descarga desde otra página es legítimo.

`/health` solo queda exento para los **sondeos reales**: `GET` o `HEAD` sin `Origin` y sin `Sec-Fetch-Site`
`cross-site`/`same-site`. Los sondeos del orquestador llegan con el `Host` del pod o del balanceador. Una página
ajena con `<img src=".../health">` sí envía esas señales, así que recibe 403 antes de que se ejecute `SELECT 1` ni
los pings a Redis y S3; además `/health` tiene su propio contador de uso (600 por minuto y cliente) en lugar de
quedar fuera del límite. **Límite conocido:** la exención tampoco comprueba `Host`, y con DNS rebinding el
navegador declara `same-origin`; la ruta responde, pero solo con el estado de las dependencias y bajo su tope.
Es la única ruta sin comprobación de `Host`, y se acepta porque los sondeos del orquestador la necesitan.

**CORS** (`@fastify/cors`) se registra **solo si `ALLOWED_ORIGINS` no está vacío**, con la misma lista, métodos
`GET, HEAD, POST, PUT, OPTIONS`, cabeceras `Content-Type, If-Match, Authorization, X-API-Key, Range`, sin
credenciales (`credentials: false`) y exponiendo `ETag`, `Content-Range`, `Content-Disposition`,
`Content-Length`, `Accept-Ranges` y `Retry-After` (el cliente web los necesita para la edición con `If-Match` y
las descargas con `Range`). La lista se valida al arrancar: **`*` y cualquier valor ambiguo hacen fallar el
arranque**, no se interpretan.

Cabeceras de respuesta: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` y, si el handler no puso
la suya, `Cache-Control: no-store`.

La guardia se registra **antes** que multipart, CORS y el límite de uso: una petición ya identificada como ajena
no debe consumir cuota ni procesar su cuerpo.

Las respuestas de error con el cuerpo sin leer (403, 421, 413, 429...) no cierran la conexión de golpe: un cierre
brusco hace que el navegador reciba un reinicio de la conexión y pierda la respuesta (XMLHttpRequest no entrega nada
hasta terminar de subir). El API lee y descarta el resto del cuerpo con tope de 16 MiB y 10 s y entonces corta (como el
«lingering close» de nginx). Límite conocido: un rechazo temprano con un cuerpo de más de 16 MiB acaba como error de red
en el navegador; la comprobación previa del cliente (tamaño máximo) es la defensa real. Los mensajes de error son fijos y no reflejan el `Host` ni el `Origin` recibidos. Al arrancar, el API
registra la política efectiva (hosts y orígenes aceptados) para que un error de configuración se vea en el log.

## Alternativas consideradas

### Token anti-CSRF (doble envío de cookie o token sincronizado)
- Ventajas: patrón conocido.
- Inconvenientes: exige cookies o estado de sesión que el API no tiene; no frena el DNS rebinding.
- Rechazada: protege credenciales ambientales que aquí no existen.

### Solo CORS restrictivo
- Inconvenientes: CORS impide **leer** la respuesta, no **enviar** la petición. El POST multipart simple llega y
  se ejecuta igualmente.
- Rechazada como única medida.

### `API_KEY` obligatoria siempre
- Ventajas: cierra ambas vías sin lógica de navegador.
- Inconvenientes: rompe el uso local de desarrollo y las pruebas; sigue siendo recomendable fuera de
  `127.0.0.1`. Se mantiene opcional, y esta guardia protege el caso en que no esté.

### Comodín en la lista de orígenes u hosts
- Rechazada: es justo la configuración que estas listas existen para impedir.

## Consecuencias
- **Cambio de comportamiento:** llegar al API por una IP o un nombre que no sea de bucle local (otra máquina de la
  red, un balanceador con nombre propio) recibe 421 hasta declararlo en `ALLOWED_HOSTS` (solo el nombre, sin
  puerto). El compose lo deja explícito en una variable.
- **Cliente web (fase 4b):** al servirse desde otro origen (p. ej. `http://localhost:5173` en desarrollo) hay que
  añadirlo a `ALLOWED_ORIGINS`. Servido por el propio API, no hace falta.
- **Detrás de un proxy:** el proxy debe **reenviar el `Host` original** (en nginx, `proxy_set_header Host $host`).
  La guardia lee únicamente `Host`: no usa `X-Forwarded-Host`, porque cualquier cliente puede enviarlo y se
  convertiría en una vía para eludir la comprobación. Si el proxy lo reescribe, hay que listar ese nombre; con
  `TRUST_PROXY` en `true` la IP del cliente sale de `X-Forwarded-For` y se puede falsificar (ver ADR 0010), pero
  esta guardia no depende de ella.
- **Cuando llegue la autenticación de personas usuarias con cookies (fase 5b)** la premisa de esta decisión
  cambia: las cookies serán `SameSite=Lax` o `Strict`, `HttpOnly` y `Secure`, y las peticiones que modifican
  llevarán además un token anti-CSRF (o exigirán una cabecera propia, que fuerza el preflight). La comprobación de
  `Origin` de esta guardia se mantiene como defensa en profundidad. *(Actualización, ADR 0016: las cookies llegaron con
  `SameSite=Lax`, `HttpOnly`, `Secure` bajo https y la cabecera propia `X-Requested-With`.)*
- **Acceso a redes privadas:** el API no responde `Access-Control-Allow-Private-Network`. Los navegadores que
  aplican Private Network Access bloquean que una página pública llegue a `127.0.0.1` en el preflight; no se
  habilita a propósito y no hace falta para el cliente web, que el propio API sirve desde su mismo origen (`apps/web/public`, `WEB_ROOT`): sin CORS,
  con CSP restrictiva (`connect-src 'self'`, por lo que un `cf-api-base` de otro origen queda bloqueado) y fuera de
  `API_KEY` y del límite de uso. *(Actualización, ADR 0015: la `API_KEY` compartida se sustituyó por claves por tenant y la interfaz web
  ya las manda; esta guardia protege además `/web-config.json`, que entrega la clave por defecto.)*
- **Pruebas:** la función `evaluate` se prueba de forma exhaustiva (`test/request-guard.spec.ts`) y el
  comportamiento completo contra el API real (`test/origin.e2e.spec.ts`): un POST multipart con `Origin` ajeno
  devolvía 202 y ahora 403 sin crear el trabajo.
