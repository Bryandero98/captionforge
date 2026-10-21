# ADR 0005: BullMQ sobre Redis como cola, con consumidor Python

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
El API (Node) encola y el worker (Python) consume. Había una duda técnica real: BullMQ nació en
Node y la compatibilidad de su cliente Python (`bullmq` en PyPI) con un productor Node no estaba
demostrada para lo que necesitamos (progreso estructurado, cancelación, fallos).

## Decisión
Usar BullMQ en ambos lados (`bullmq` 6.x en Node con `ioredis`; `bullmq` 3.4.x en Python) y
**demostrarlo con una prueba de extremo a extremo** (`tools/smoke`, se ejecuta en CI) antes de
construir sobre ello. Resultados con Redis real:

| Escenario | Resultado |
|---|---|
| Trabajo encolado en Node, procesado en Python, resultado validado por esquema | Funciona |
| Progreso estructurado (`updateProgress`) visible en Node vía `QueueEvents` | Funciona |
| Fallo con `JobError` serializado en `failedReason`; `attempts: 1` sin reintentos | Funciona |
| Mismo `jobId` encolado dos veces: se procesa una sola vez | Funciona |
| Cancelación por Redis pub/sub → `Worker.cancelJob` → señal de aborto | Funciona (~0,2 s) |
| Trabajo bloqueante de CPU de 9 s en un hilo con `lockDuration` de 3 s | Sin `stalled` |
| El mismo trabajo bloqueando el bucle de eventos | **`stalled`** (la prueba negativa falla como debe) |

## Alternativas consideradas

### Celery (Python) con un puente desde Node
- Contra: dos ecosistemas de cola; el API tendría que hablar el protocolo de Celery.
- Descartada.

### Redis Streams a mano
- Pro: sin dependencia de BullMQ.
- Contra: reimplementar candados, reintentos, progreso, trabajos atascados y deduplicación.
- Descartada.

### RabbitMQ / SQS
- Pro: robustos.
- Contra: un servicio más que operar sin necesitar sus garantías; BullMQ da lo necesario.
- Descartada por ahora.

## Consecuencias
- BullMQ 6 no trae `ioredis`: hay que declararlo como dependencia en el API.
- Redis debe tener `maxmemory-policy noeviction` (BullMQ lo exige) y `appendonly yes` (la cola
  sobrevive a un reinicio); el compose lo configura y `verify-infra.sh` lo comprueba.
- Los dos clientes evolucionan por separado: las versiones se fijan y el smoke test de CI avisa
  si una actualización rompe la interoperabilidad.
