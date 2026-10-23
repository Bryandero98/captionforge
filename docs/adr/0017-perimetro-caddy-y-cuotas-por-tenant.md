# ADR 0017: Perímetro con Caddy y cuotas por tenant en Redis (fail-open)

## Estado
Aceptada (issue [#8](https://github.com/Bryandero98/captionforge/issues/8), fase 5b; entrega junto con el [ADR 0018](0018-observabilidad-registros-json-y-metrics.md)).
Completa los límites por IP del [ADR 0010](0010-endurecimiento-del-api-y-trabajos-huerfanos.md) con límites por tenant y
resuelve su advertencia sobre `TRUST_PROXY`.

## Fecha
2026-10-23

## Contexto
El API ya limita por IP, pero con varias personas en el mismo servidor el recurso escaso es otro: el worker (GPU) y el
almacenamiento. Una sola cuenta que sube sin parar llena la cola de las demás aunque venga de IPs distintas, y detrás de un
NAT muchas personas comparten IP. Además el servicio se publica en internet: hace falta TLS, y el API no debe ser el que termina
la conexión pública.

## Decisión
1. **Caddy como proxy inverso** (`--profile proxy`). Es lo único expuesto (80/443); el API sigue publicado solo en
   `127.0.0.1`. Certificados automáticos de Let's Encrypt con un dominio real (`SITE_ADDRESS`); `localhost` usa la CA interna de
   Caddy para probar. HSTS opcional (`HSTS_MAX_AGE`, 0 por defecto para no fijarlo en `localhost`). `flush_interval -1` para SSE y
   descargas grandes. Los registros de acceso de Caddy ocultan `X-Api-Key` y los parámetros `code`/`state` de OAuth.
2. **Proxy de confianza.** El adaptador de Fastify confía en `X-Forwarded-For/Proto/Host` **solo** de las redes de `TRUST_PROXY`
   (con Caddy: la red de Docker, p. ej. `172.16.0.0/12`). Caddy descarta el `X-Forwarded-For` que traiga el cliente y pone la IP real,
   así que falsificarlo no sirve; se comprobó contra Caddy real (la IP registrada es la del par, no la inventada). El atributo
   `Secure` de la cookie de sesión **no depende de la petición** sino de `PUBLIC_URL` (https), por lo que el proxy no puede
   romperlo: con `PUBLIC_URL=https://…` la cookie sale `Secure` y con prefijo `__Host-`.
3. **Cuotas por tenant**, aplicadas por un interceptor antes de leer el cuerpo (como los límites por IP):
   - **Carga:** `TENANT_UPLOADS_PER_HOUR` (60 por defecto). Contador de ventana fija **en Redis**, atómico (`INCR` + `PEXPIRE` en un
     solo script Lua para que no quede una clave sin vencimiento). Clave `captionforge:quota:<tenant>:uploads:<hora>`.
   - **Cola:** `TENANT_MAX_QUEUED_JOBS` (20 por defecto): trabajos `QUEUED` o `RUNNING` del tenant. Se cuentan **en PostgreSQL**, no
     en Redis: el worker termina los trabajos sin avisar al API, así que un contador en Redis se desviaría y habría que reconciliarlo;
     el estado ya vive en la base y la consulta usa el índice por tenant.
   - Ambos devuelven `429` con `Retry-After`. `0` desactiva cada una. Aplican a la subida; el quemado solo a la cola.
4. **Fail-open.** Si Redis no responde (error o más de 500 ms), la cuota se registra como fallo (registro limitado a uno cada 30 s y
   contador `captionforge_quota_redis_failures_total`) y la petición **pasa**. La disponibilidad pesa más que la cuota: es un escudo
   operativo, no una barrera de seguridad. El aislamiento entre tenants (ADR 0015) no depende de ella. El cliente de cuotas tiene
   `enableOfflineQueue: false`, así que una caída falla al instante en lugar de acumular comandos.

## Alternativas descartadas
- **Cuota en `@fastify/rate-limit` por tenant.** Acepta un almacén Redis y una función de clave, pero corre en `onRequest`, antes de
  la autenticación, y no conoce el tenant. Mover la autenticación antes cambia todo el orden de ganchos.
- **Contador de trabajos en cola en Redis.** Se desvía (ver arriba) y exige un reconciliador.
- **Fail-closed.** Una caída de Redis dejaría sin servicio a todas las cuentas por un escudo; se descartó por decisión del Tech Lead.
- **nginx/Traefik.** Más configuración para el mismo resultado; Caddy da TLS automático con un archivo de 40 líneas.

## Consecuencias
- Un servidor público necesita `SITE_ADDRESS`, `PUBLIC_URL=https://…`, `ALLOWED_HOSTS` con ese dominio, `LOCAL_MODE=false` y
  `TRUST_PROXY` con la red de Docker. Con `TRUST_PROXY=true` cualquiera podría falsificar su IP: no se recomienda.
- Si Docker usa un rango distinto de `172.16.0.0/12` para la red del proyecto, `TRUST_PROXY` debe ajustarse; si no, el API vería
  como cliente la IP de Caddy y todos compartirían el límite por IP (falla hacia más estricto, no hacia más abierto).
- Con Redis caído la cuota por hora no se aplica, pero sí la de cola (PostgreSQL) y los límites por IP en memoria.
- El healthcheck del contenedor usa `127.0.0.1`: `localhost` resolvía a IPv6 y `wget` de BusyBox no reintenta en IPv4.
