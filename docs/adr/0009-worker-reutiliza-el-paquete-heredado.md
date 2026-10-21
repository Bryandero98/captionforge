# ADR 0009: El worker reutiliza el paquete heredado y no lo copia

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
`legacy/` contiene la aplicación original (FastAPI + faster-whisper + ffmpeg) con cientos de horas de
correcciones acumuladas: reparto del trabajo de ffmpeg con tiempos máximos (PR #7), descarga y
comprobación de memoria de los modelos, formato SRT, traducción con Argos y cálculo de la forma de
onda. El worker nuevo necesita exactamente esos bloques, pero no su servidor HTTP, su almacén de
trabajos en memoria ni su interfaz.

Opciones:

1. **Copiar** los módulos a `apps/ai-worker`. Dos copias que divergen; cada corrección hay que hacerla dos veces.
2. **Reescribirlos** desde cero. Se pierde lo aprendido y se reintroducen fallos ya corregidos.
3. **Instalar `legacy/` como dependencia** del worker y usar sus módulos puros.

## Decisión
Opción 3. `apps/ai-worker` depende del paquete `captionforge` (instalado desde `legacy/`, en el
entorno de desarrollo con `pip install -e` y en la imagen con `pip install ./legacy`) y solo importa
bloques sin estado de servidor:

| Módulo heredado | Uso en el worker |
| --- | --- |
| `ffmpeg_utils`, `ffmpeg_locator` | Construcción de órdenes y localización de ffmpeg |
| `pipeline._run_ffmpeg` | Ejecución con tiempos máximos y limpieza del subproceso |
| `models` | Descarga con progreso, comprobación de memoria, selección de dispositivo |
| `srt`, `translate`, `waveform` | Formato SRT, traducción, picos de la forma de onda |

No se usan `app`, `routes`, `jobs` (almacén en memoria) ni `static`. Todo lo que es del worker
(consumo de BullMQ, estado en PostgreSQL, S3, cancelación, progreso) vive en `apps/ai-worker/src/ai_worker`.

Reglas para que el acoplamiento no se vuelva una deuda:

- El worker importa de `legacy/` solo lo de la tabla. Un símbolo privado (`_run_ffmpeg`) queda
  anotado aquí: si el paquete heredado lo renombra, fallan las pruebas del worker, que usan ffmpeg real.
- `legacy/` no importa nada del worker ni del monorepo. Sigue siendo publicable por su cuenta
  (su propio workflow `ci.yml` y `release.yml`).
- Faster-whisper y Argos se importan de forma diferida en el código heredado. Por eso las pruebas
  del worker no necesitan torch y simulan Whisper; la imagen de despliegue sí lo trae
  (torch en versión CPU para no arrastrar CUDA).

## Consecuencias
- Una corrección en ffmpeg, SRT o modelos beneficia a ambas aplicaciones a la vez.
- Mientras `legacy/` exista, la imagen del worker incluye también FastAPI y uvicorn (dependencias
  declaradas del paquete) que no usa; es peso muerto asumido hasta que se extraigan los bloques
  comunes a un paquete propio.
- Cuando `legacy/` se retire, esos módulos se mueven a `packages/` y el worker cambia una línea de
  instalación, no su código.
