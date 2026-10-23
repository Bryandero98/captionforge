# ADR 0018: Observabilidad: registros JSON, identificador de petición y /metrics interno

## Estado
Aceptada (issue [#9](https://github.com/Bryandero98/captionforge/issues/9), fase 5b; entrega junto con el [ADR 0017](0017-perimetro-caddy-y-cuotas-por-tenant.md)).

## Fecha
2026-10-23

## Contexto
Con varias cuentas en un servidor, un fallo se investiga desde los registros y las métricas, no desde la consola. El texto libre de
Nest no se filtra ni se agrega; no había identificador para seguir una petición a través de Caddy, el API y el worker; y nada
medía la salud de las cuotas ni el estado de los trabajos. Al mismo tiempo, los registros no deben guardar secretos
(claves, cookies, códigos de OAuth) ni datos de personas que una métrica no necesita.

## Decisión
1. **Registros JSON** (`LOG_FORMAT=json`, por defecto en los contenedores; `text` en desarrollo). Una línea por evento con
   `time`, `level` (`debug|info|warn|error|fatal`), `context` y `msg`; los objetos se mezclan como claves. `JSON.stringify` escapa
   saltos de línea y comillas, así que un valor del cliente no puede falsificar otra línea. El worker de Python emite exactamente el
   mismo formato (`ai_worker/logfmt.py`).
2. **Una línea por petición** (`event: "http_request"`): `requestId`, `method`, **`route` (patrón, p. ej. `/v1/jobs/:id`)**, `status`,
   `durationMs`, `tenantId`, `ip`. Nunca la URL, la cadena de consulta, cabeceras, cookies ni el cuerpo: los códigos de OAuth del
   `callback` y los ids de trabajos quedan fuera. `/health` no se registra (se consulta cada pocos segundos).
3. **`X-Request-Id`.** Caddy lo genera; el API lo acepta solo si cumple `[A-Za-z0-9._-]{8,64}` (si no, crea un UUID) y lo devuelve en la
   respuesta para correlacionar.
4. **`/metrics` en un puerto aparte** (`METRICS_PORT`, 9090; `0` lo desactiva), en `METRICS_HOST` (loopback por defecto; `0.0.0.0` en el
   contenedor). El puerto público **no** sirve `/metrics` (404, con prueba), el puerto 9090 **no se publica** en el anfitrión y
   Caddy además responde 404 a esa ruta: tres capas, y que una falle no expone nada. Prometheus lo lee por la red interna.
5. **Métricas** (`prom-client`, registro propio por aplicación): `captionforge_http_requests_total{method,route,status}`,
   `captionforge_http_request_duration_seconds`, `captionforge_quota_denied_total{reason}`,
   `captionforge_quota_redis_failures_total`, `captionforge_logins_total{provider,result}`, `captionforge_jobs{status}` (de
   PostgreSQL al consultar) y las métricas estándar del proceso. Etiquetas de cardinalidad acotada: **sin tenants, claves ni IP**.
6. **Perfil `metrics`**: Prometheus (retención 15 días, interfaz solo en `127.0.0.1:9091`) y Grafana (`127.0.0.1:3001`, sin registro
   ni acceso anónimo, con el panel «CaptionForge · API» aprovisionado). Grafana se niega a arrancar sin `GRAFANA_ADMIN_PASSWORD`
   para no quedar con `admin/admin`.

## Alternativas descartadas
- **pino / nestjs-pino.** Mejor rendimiento bruto, pero cambia el registrador de todo Nest y añade dependencias; un registrador de
  ~60 líneas cubre el formato, y el volumen de este servicio (vídeos, no miles de peticiones por segundo) no lo exige.
- **OpenTelemetry (trazas).** Útil con muchos servicios; aquí hay un API y un worker unidos por una cola, y el `requestId` más el
  `jobId` bastan. Se puede añadir después sin cambiar este formato.
- **`/metrics` en el puerto público con autenticación.** Una ruta menos que proteger es mejor que una protegida.
- **Contar trabajos en métricas con un contador propio.** Se desvía; la consulta agrupada a PostgreSQL al leer es exacta y barata.

## Consecuencias
- `captionforge_jobs` hace una consulta agrupada en cada lectura (cada 15 s con Prometheus): despreciable con el índice actual.
- Quien lea los registros desde Docker obtiene JSON; para leerlos en persona: `docker compose logs api-gateway | jq`.
- El tamaño de los registros crece por línea de petición; `json-file` ya rota a 3 × 10 MiB.
