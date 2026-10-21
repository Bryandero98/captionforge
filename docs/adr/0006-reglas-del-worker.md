# ADR 0006: Reglas del worker de IA

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
Transcribir y quemar subtítulos son trabajos de minutos u horas, intensivos en CPU, que lanzan
subprocesos (ffmpeg). Un worker de cola que los trata como código asíncrono normal falla de formas
silenciosas: trabajos duplicados, procesos huérfanos, cancelaciones que no cancelan.

## Decisión
Reglas obligatorias para `apps/ai-worker`:

1. **Nada pesado en el bucle de eventos.** Whisper y ffmpeg corren en un hilo o subproceso
   (`asyncio.to_thread`, `asyncio.create_subprocess_exec`). Motivo demostrado en
   `tools/smoke`: bloqueado el bucle, el candado no se renueva y BullMQ marca el trabajo `stalled`.
2. **Concurrencia 1 por proceso** (`WORKER_CONCURRENCY=1`). El escalado es por más réplicas, no por
   más trabajos en el mismo proceso.
3. **Cancelación cooperativa.** Un listener de Redis pub/sub (`captionforge:cancel`) llama a
   `Worker.cancelJob`; el trabajo observa la señal de aborto y termina con `CANCELLED`. Los
   mensajes malformados se ignoran sin tumbar al worker.
4. **Subprocesos con tiempo máximo y limpieza garantizada**: `try/finally` con `terminate()` y
   luego `kill()`; `FFMPEG_STALL_TIMEOUT_SECONDS=300` y `FFMPEG_TOTAL_TIMEOUT_SECONDS=21600`
   (corrección ya fusionada en el paquete heredado, PR #7).
5. **Validación estricta de entrada** con los modelos del contrato, aunque el API ya validó.
6. **Sin reintentos automáticos** (`attempts: 1`): un fallo se informa con un código del contrato;
   el usuario decide reintentar.
7. **Contenedor con `init: true`** (recoge procesos zombi) y `stop_grace_period: 60s`.
8. **El modelo de Whisper se carga una vez** por proceso, no por trabajo.
9. **Conexión a PostgreSQL en `autocommit` o con transacciones cortas.** Un trabajo dura horas;
   `cf_worker` tiene `idle_in_transaction_session_timeout = 30s`, y una conexión que abre una
   transacción (psycopg lo hace en el primer `SELECT` si no hay `autocommit`) y se queda quieta
   mientras corre ffmpeg es cerrada por el servidor. Se probará con una conexión inactiva más de
   60 s (Fase 3).

## Alternativas consideradas
- **Un proceso por trabajo** (arrancar y destruir): aísla mejor pero recarga el modelo cada vez
  (decenas de segundos y GB de RAM). Descartada.
- **Reintentos automáticos de BullMQ:** esconden fallos deterministas (video corrupto) y repiten
  horas de cómputo. Descartada.

## Consecuencias
- Las reglas 1, 3 y 5 están cubiertas por el smoke test; las 4 y 8 por las pruebas del worker en
  la Fase 3.
- La memoria del contenedor del worker se fija en 4 GB por defecto (`WORKER_MEM_LIMIT`).
