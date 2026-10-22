# ADR 0013: Limpieza de audio opcional con Demucs en un subproceso, con respaldo al audio original

## Estado
Aceptada (issue [#5](https://github.com/Bryandero98/captionforge/issues/5)). La opción queda **desactivada por defecto**.

## Fecha
2026-10-22

## Contexto
`faster-whisper` transcribe el audio tal como sale de ffmpeg. Con música o ruido fuerte sobre la voz la transcripción
puede empeorar. El issue propone aislar la voz antes de transcribir con Demucs y avisa de tres costes reales: una
tercera pila de ML pesada, tiempo extra para un paso que la mayoría de los videos no necesita, y que la separación puede
introducir artefactos que cambian un error por otro. Pide medir antes de comprometerse.

Restricción de hardware que condiciona el diseño: cargar Whisper (CTranslate2) y un modelo de separación (PyTorch) a
la vez agota la VRAM de una GPU normal. Hoy el `ModelProvider` mantiene Whisper cargado entre trabajos.

## Decisión
1. **Modelo:** `htdemucs` (Demucs 4.0.1), solo el stem `vocals`. Pesos de unos 80 MB, descargados una vez con la
   comprobación de hash de `torch.hub`.
2. **Opción por trabajo:** `options.cleanAudio` (booleano, `false` por defecto) en `transcribe-job.v1`; el resultado
   lleva `audioCleaned`; dos etapas nuevas, `downloading_separation_model` y `separating_voice`. Cambios aditivos:
   `schemaVersion` sigue en 1 y los mensajes anteriores siguen siendo válidos.
3. **Secuencial por construcción, en un subproceso:** con la opción activa el worker (a) suelta Whisper
   (`ModelProvider.release()`), (b) lanza `python -m ai_worker.separate_cli`, (c) al terminar el proceso el sistema
   operativo recupera toda la VRAM y (d) Whisper se recarga y transcribe el audio aislado. `torch` y `demucs` solo se
   importan en el hijo: el worker no depende de ellos.
4. **Respaldo:** si la separación falla (falta de memoria, pesos sin descargar, error del hijo, tiempo agotado o silencio
   prolongado), el trabajo **continúa con el audio original**, el resultado marca `audioCleaned: false` y la web lo avisa.
   Una cancelación sí cancela el trabajo.
5. **Procesado por trozos de 30 s** con 1,5 s de contexto descartado a cada lado: la memoria no crece con la duración y el
   avance es real (Demucs 4.0.1 no tiene `callback` de progreso interno).
6. **Dependencias fijadas** en `apps/ai-worker/requirements-separation.txt`, instaladas sin resolver dependencias, y
   `torch`/`torchaudio` **2.11** (ver Consecuencias). En el Dockerfile solo con `--build-arg WITH_SEPARATION=1`.
7. **Web:** casilla «Limpiar ruido de fondo (más lento, para música o ruido fuerte)», desactivada por defecto; el
   resultado muestra «Audio limpiado: sí/no» cuando se pidió, con una alerta informativa si hubo respaldo.

## Alternativas descartadas
- **Spleeter:** TensorFlow (otra pila más) y sin mantenimiento.
- **`htdemucs_ft`:** unas 4 veces más lento por una mejora que no justifica el coste en CPU.
- **MDX-Net / ONNX:** más ligero, pero añade `onnxruntime` y su propio ecosistema de pesos.
- **Open-Unmix:** peor calidad de aislamiento de voz.
- **Separar en el mismo proceso** (`del` + `empty_cache`): no garantiza devolver la VRAM; el subproceso sí.
- **Activarla siempre:** el diálogo limpio, el caso habitual, no gana nada y paga todo el coste.

## Resultados de la medición
Script: `apps/ai-worker/scripts/benchmark_separation.py`. Locución de 49 s (voz sintética de Windows, texto de referencia
conocido, WER de la voz sola 0,020), modelo Whisper `base` en CPU (int8), idioma `en`, Demucs `htdemucs` real a través del hijo
`separate_cli`. «Music» es música sintética (acordes con armónicos, bajo y percusión); «noise» es ruido rosa. El dB es la
relación voz/ruido: 0 dB = mismo volumen, −10 dB = el ruido es unas 3 veces más fuerte que la voz.

| Mezcla (voz + …) | WER sin limpiar | WER limpiando | Mejora | Separación (s) | Whisper original (s) | Whisper limpio (s) |
|---|---|---|---|---|---|---|
| music 0 dB | 0.020 | 0.020 | +0.000 | 191.8 | 7.5 | 9.8 |
| music 5 dB | 0.020 | 0.020 | +0.000 | 130.7 | 8.4 | 9.0 |
| music 10 dB | 0.020 | 0.020 | +0.000 | 131.2 | 8.9 | 9.4 |
| noise 0 dB | 0.034 | 0.034 | +0.000 | 122.2 | 8.2 | 8.7 |
| noise 5 dB | 0.034 | 0.041 | -0.007 | 178.9 | 8.2 | 14.4 |
| noise 10 dB | 0.027 | 0.027 | +0.000 | 140.5 | 11.0 | 8.2 |
| music -5 dB | 0.027 | 0.020 | +0.007 | 86.5 | 8.5 | 9.2 |
| music -10 dB | 0.527 | 0.020 | +0.507 | 71.2 | 5.5 | 6.4 |
| music -15 dB | 1.000 | 0.020 | +0.980 | 60.2 | 0.3 | 6.5 |

Lectura:
- **Con música a −10 y −15 dB la limpieza decide si hay transcripción:** el WER pasa de 0,527 a 0,020 y de 1,000 a 0,020. A −15 dB
  Whisper, sin limpiar, no entregó prácticamente nada.
- **De 0 a +10 dB (y a −5 dB) no aporta:** Whisper ya transcribe igual de bien sin limpiar (la mejora es de 0 a 1 palabra). Es el
  caso de la mayoría de los videos; por eso la opción es opt-in.
- **Ruido que no es música (rosa):** sin mejora medible y con un empeoramiento de una palabra a 5 dB. Demucs está entrenado con
  música, así que no es la herramienta para ruido ambiental.
- **Coste en CPU:** entre 1,2 y 4 veces la duración del audio según la carga de la máquina (con la máquina ocupada subió a
  2,5–4x). Es la razón de la etiqueta «más lento» en la interfaz.

Límites de la medición, dichos en voz alta: música y voz sintéticas (una canción real con voces cantadas se separa peor: las
voces cantadas pueden colarse en el stem `vocals`), una sola voz y un solo idioma, modelo `base`, solo CPU (no había GPU
disponible, así que no se midió el tiempo ni el pico de VRAM en GPU) y sin ruido real de grabaciones de campo. Es una prueba de que
el mecanismo funciona y de dónde ayuda; antes de prometer un número a quien lo use hay que repetirla con grabaciones reales.

## Consecuencias
- **`torchaudio` ya no sigue a `torch`.** Demucs 4.0.1 importa `torchaudio` (vía `openunmix`) y esa biblioteca se quedó en
  la 2.11 mientras `torch` sigue subiendo. Con un `torch` más nuevo el import falla, así que la separación fija ambos en
  2.11. El hijo evita usar `torchaudio` directamente (remuestrea con `julius`).
- **`diffq` no se instala:** `demucs` lo declara, pero es código C sin ruedas para Python 3.12+ y `htdemucs` no lo usa.
  Por eso la lista completa va en `requirements-separation.txt` (comprobada ejecutando el modelo real) y no como extra de pip.
- **`release()` asume `WORKER_CONCURRENCY=1`** (el valor por defecto): con trabajos simultáneos otro trabajo conserva su
  referencia al modelo y la memoria no se libera hasta que termine.
- **Demucs original:** el repositorio de Meta ya no evoluciona; si deja de funcionar con un `torch` futuro, la opción es
  un fork mantenido o cambiar de modelo. Mientras tanto la versión queda fijada.
- **Imagen:** la variante con separación (`WITH_SEPARATION=1`) no se construye en la CI; la imagen por defecto no cambia.
- **Seguridad:** el hijo hereda el entorno del worker; no recibe secretos adicionales ni red más allá de la descarga de
  pesos. Su salida de error nunca llega a la persona usuaria (puede traer rutas).
- **Costes aceptados:** una dependencia pesada opcional y tiempo extra, solo para quien lo pide.
