# ADR 0010: Endurecimiento del API y cierre de trabajos huérfanos

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
Con el API y el worker completos quedaban tres huecos que no son visibles en una demostración y sí en
producción:

1. **Trabajos que nadie cierra.** Si el worker muere a mitad de un trabajo (falta de memoria, corte),
   la fila de PostgreSQL dice `RUNNING` para siempre y la persona usuaria ve una barra congelada.
   BullMQ detecta el candado vencido (*stalled*), pero el cliente Python emite `stalled`, no `failed`,
   y solo lo hace si queda algún worker vivo.
2. **API abierto.** Cualquiera que llegue al puerto puede subir videos de hasta 4 GiB y encolar
   trabajos de CPU durante horas.
3. **Cupo de conexiones.** El adaptador de Prisma para `node-postgres` ignora `connection_limit` de la
   URL; el rol `cf_api` admite 20 conexiones en total, y sin un tope explícito varias réplicas (o las
   pruebas, que levantan una instancia por archivo) pueden agotarlo.

## Decisión

**Trabajos huérfanos, en dos capas** (cada una cubre el fallo de la otra):

- El worker escucha `stalled` y cierra la fila como `FAILED`/`INTERNAL`. La escritura es condicional
  (`WHERE status IN ('QUEUED','RUNNING')`): si el trabajo ya terminó con su código real, no se pisa.
  Probado simulando un worker caído: se borra el candado en Redis y la fila deja de decir `RUNNING`.
- El API ejecuta un recolector (`ReaperService`) cada `REAPER_INTERVAL_SECONDS` (60): cierra los
  `RUNNING` cuyo `updatedAt` lleva más de `JOB_STALE_MINUTES` (20) sin cambiar y los `QUEUED` que ya no
  existen en su cola de Redis pasados `QUEUED_GRACE_MINUTES` (5). Cubre el caso de que **no quede ningún
  worker** que detecte el atasco. El criterio es el último latido (`updatedAt`, que el worker escribe
  varias veces por minuto en cualquier etapa), no cuándo empezó el trabajo: un video de dos horas no es
  un huérfano.

**API**: clave compartida opcional (`API_KEY`, mínimo 24 caracteres; `Authorization: Bearer` o
`X-API-Key`; comparación de tiempo constante sobre hashes; `/health` abierto) y límite de peticiones
por IP con contador aparte para las subidas (`RATE_LIMIT_PER_MINUTE`=240, `UPLOAD_RATE_LIMIT_PER_MINUTE`=10).
`TRUST_PROXY` es explícito: detrás de un proxy sin activarlo todos los clientes comparten una IP.

**Conexiones**: `DB_POOL_MAX` (10) fija el pool del adaptador; el valor se reparte entre las réplicas
dentro de las 20 conexiones de `cf_api`.

## Alternativas descartadas
- **Autenticación de personas usuarias (JWT, OAuth).** Depende de cómo sea el cliente web (fase 4b) y de
  si habrá cuentas; implementarla ahora sería inventar el producto. La clave compartida sirve para un
  despliegue detrás de otro servicio o proxy, que es el que existe hoy.
- **Un latido explícito del worker.** `updatedAt` ya es un latido gratis; otro mecanismo duplicaría
  estado que puede divergir.
- **Reencolar los trabajos atascados.** Repetiría horas de cómputo sin que nadie lo haya pedido y puede
  repetirlo en bucle si el trabajo es justo lo que mata al worker (ADR 0006: `attempts: 1`).
- **Límites con un contador único.** Un cliente que consulta el estado cada segundo se quedaría sin
  poder subir.

## Consecuencias
- Un `RUNNING` legítimo sin ningún cambio durante 20 minutos se cerraría por error. El worker informa
  progreso en cada etapa (ffmpeg corta a los 5 minutos sin actividad), así que se considera imposible
  hoy; si una etapa nueva no informa progreso, hay que subir `JOB_STALE_MINUTES` o hacerla informar.
- Con `API_KEY`, `EventSource` del navegador no puede enviar cabeceras: el cliente web tendrá que usar
  `fetch` con streaming o un proxy que añada la clave.
- Las pruebas desactivan límites y recolector (`scripts/with-env.mjs`) y las suites de seguridad y del
  recolector construyen su propia configuración, para que ni los límites ni el recolector interfieran
  con el resto.
