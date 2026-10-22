# ADR 0014: Identificar quién habla (opcional) con pyannote en un subproceso, con respaldo a la transcripción normal

## Estado
Aceptada (issue [#4](https://github.com/Bryandero98/captionforge/issues/4)). La opción queda **desactivada por defecto** y
solo se ofrece si el servidor tiene un token de Hugging Face.

## Fecha
2026-10-22

## Contexto
Whisper devuelve texto con tiempos, pero no sabe quién habla. En entrevistas y reuniones, saber quién dice cada frase es lo
que hace útil el subtítulo. El issue propone [pyannote.audio](https://github.com/pyannote/pyannote-audio) y avisa de los
costes reales: otra pila de ML pesada, un modelo de **acceso restringido** (hay que aceptar sus condiciones y usar un token de
Hugging Face), tiempo extra en CPU y que alinear los turnos de voz con los segmentos de Whisper es aproximado.

Restricciones que condicionan el diseño:

- Whisper (CTranslate2) y pyannote (PyTorch) juntos agotan la VRAM de una GPU normal (misma restricción que en el
  [ADR 0013](0013-limpieza-de-audio-demucs-en-subproceso.md)).
- Un token es un secreto: no puede acabar en un argumento de proceso, un log, un mensaje de error ni en el navegador.
- El API no debe poder usar el token: solo necesita saber si la función existe.

## Decisión
1. **Modelo exclusivo:** `pyannote/speaker-diarization-3.1` (con `segmentation-3.0`, ambos de acceso restringido con
   aceptación automática). `pyannote.audio` 4.0.7 con `torch`/`torchaudio` **2.11**, la misma pila que la limpieza de audio.
2. **Opción por trabajo:** `options.diarize` (booleano, `false` por defecto) en `transcribe-job.v1`; el resultado lleva
   `diarized`; cada segmento de `segments.json` puede llevar `speaker`; dos etapas nuevas, `downloading_diarization_model` y
   `diarizing`. Todo aditivo: `schemaVersion` sigue en 1 y los mensajes anteriores siguen siendo válidos.
3. **Secuencial, en un subproceso:** con la opción activa el worker (a) transcribe con Whisper, (b) lo suelta
   (`ModelProvider.release()`), (c) lanza `python -m ai_worker.diarize_cli` y (d) asigna el hablante a cada segmento. `torch` y
   `pyannote` solo se importan en el hijo. El runner de subprocesos (`child.py`) es el mismo de la separación de voz: protocolo
   `PROGRESS <etapa> <fracción>`, tiempos de silencio y totales, cancelación que mata al hijo y stderr que nunca llega a quien usa
   la aplicación.
4. **Audio en memoria:** el hijo lee el WAV mono y se lo da a pyannote ya decodificado (`{"waveform", "sample_rate"}`). No pasa
   por `torchcodec`, que exigiría bibliotecas de ffmpeg compartidas que la imagen no tiene.
5. **Alineación:** si un segmento con tiempos por palabra cruza un cambio de voz, **se parte por palabras** (cada trozo conserva
   sus palabras y sus tiempos); cada palabra va al turno que más la cubre, o al más cercano si cae en un hueco. Sin tiempos por
   palabra solo se puede asignar el hablante con más solapamiento y no se parte (aproximado). Las etiquetas del modelo se
   renombran `SPEAKER_01`, `SPEAKER_02`… por orden de aparición en la transcripción.
6. **Gestión del token:** solo existe en el entorno del **worker** (`HF_TOKEN`, o `HF_TOKEN_FILE` con el token o una línea
   `HF_TOKEN=…`). Llega al hijo por variable de entorno, nunca por argumentos; `WorkerConfig` y `SubprocessDiarizer` lo ocultan
   de `repr`, y la traza del hijo se tacha antes de registrarla. El API **no** lo recibe: `DIARIZATION_ENABLED` (o, sin valor,
   la presencia de `HF_TOKEN`/`HF_TOKEN_FILE` en su entorno) solo enciende `GET /v1/capabilities` →
   `{"diarization":{"enabled":bool}}`, y rechaza con `400` un `diarize: true` si la función no está disponible. En Docker
   Compose el token entra solo en el servicio `ai-worker`.
7. **Respaldo (soft-fail):** sin token, con el token revocado o sin acceso al modelo, sin red, sin memoria, con el hijo colgado o
   pasado el tiempo máximo, el trabajo **termina igual** con la transcripción normal, `diarized: false` y un aviso en la web.
   Una cancelación sí cancela.
8. **Web:** casilla «Identificar quién habla» (desactivada y con explicación si el servidor no lo ofrece), etiqueta y color por
   hablante en el editor (ocho colores; el nombre siempre está escrito, el color nunca es la única señal), panel «Hablantes» para
   renombrar (el cambio vale para todos sus subtítulos y se guarda por el mismo `PUT` con control de versión) y prefijo opcional
   `Nombre: ` en las descargas `.srt` y `.vtt`.
9. **Fuera de este cambio:** los estilos por hablante en el video quemado (el quemado ignora `speaker`).

## Alternativas descartadas
- **`speaker-diarization-community-1`:** más reciente, pero es otro repositorio de acceso restringido con sus propias
  condiciones; se decidió un modelo exclusivo. Ver «Consecuencias» sobre su PLDA.
- **Diarizar en el mismo proceso** (`del` + `empty_cache`): no garantiza devolver la VRAM; el subproceso sí.
- **Pasar el token por argumento o por un archivo en el directorio de trabajo:** visible en la lista de procesos o persistente en
  disco. La variable de entorno del hijo muere con él.
- **Que el API conozca el token** para validarlo: ampliaría la superficie de un secreto sin ningún beneficio; basta con un
  booleano de capacidad.
- **Asignar siempre por «mayor solapamiento» de segmento** (lo que sugería el issue): un segmento que cruza un cambio de voz
  acabaría con un solo hablante y la mitad del texto mal atribuida.
- **Activarla siempre:** un video con una sola voz paga todo el coste sin ganar nada.

## Resultados de la medición
Script: `apps/ai-worker/scripts/benchmark_diarization.py`. Diálogo de 67,9 s con dos voces sintéticas de Windows (David y
Zira) que se alternan en 10 intervenciones, con verdad conocida; Whisper `base` en CPU (int8) y pyannote 3.1 real a través del
hijo `diarize_cli`.

| Medida | Resultado |
|---|---|
| Hablantes detectados | 2 (reales: 2) |
| Exactitud palabra a palabra | 146/146 = 100 % (correspondencia de etiquetas: SPEAKER_01 = David, SPEAKER_02 = Zira) |
| Whisper `base` (CPU, int8) | 18,0 s, 21 segmentos |
| Identificación (pyannote 3.1, CPU) | 202,8 s = 2,99 veces la duración del audio |
| Segmentos tras asignar | 21 (ninguno se partió) |

Lectura: con voces claras y turnos separados, la asignación fue perfecta. El coste es lo que más pesa: unas 3 veces la
duración del audio en CPU, además de Whisper; por eso la opción es opt-in y lleva la etiqueta «más lento».

Límites de la medición, dichos en voz alta: voces sintéticas (más limpias y regulares que personas reales), solo dos hablantes,
pausas claras entre intervenciones y **nada de solapamiento ni ruido**; una sola muestra y solo CPU (no había GPU disponible, así
que no se midió el tiempo ni el pico de VRAM en GPU). Es una prueba de que el mecanismo funciona, no una cifra de producto: antes
de prometer una exactitud hay que repetirla con grabaciones reales, con más voces y con habla simultánea. La partición por palabras
se verifica con pruebas unitarias (en este diálogo Whisper ya separa cada intervención con su pausa, así que casi no se ejercita).

## Consecuencias
- **`pyannote.audio` 4.x y el PLDA de «community-1».** La versión 4 carga siempre el PLDA de `speaker-diarization-community-1`
  aunque el pipeline 3.1 no lo use (agrupa de forma aglomerativa, no con VBx). Cargarlo exigiría aceptar también las condiciones
  de ese repositorio. `diarize_cli` sustituye `get_plda` por una función que devuelve `None`, de modo que basta con aceptar las
  condiciones de `speaker-diarization-3.1` y `segmentation-3.0`. Es un ajuste frágil frente a cambios internos de pyannote: la
  versión queda fijada en `requirements-diarization.txt` y, si falla, la función cae al respaldo (transcripción normal).
- **Dependencia pesada y opcional:** la imagen por defecto no cambia; `--build-arg WITH_DIARIZATION=1` instala la pila. La
  variante no se construye en la CI.
- **`release()` asume `WORKER_CONCURRENCY=1`** (el valor por defecto), igual que en el ADR 0013.
- **Un token de solo lectura, no «fine-grained» de escritura:** si se filtra, se revoca en Hugging Face sin tocar el servicio; el
  worker vuelve al respaldo hasta que se ponga otro.
- **Privacidad:** el audio se procesa en el servidor; a Hugging Face solo se le pide la descarga del modelo, no se le envía audio.
- **Telemetría de pyannote desactivada** en el hijo (`PYANNOTE_METRICS_ENABLED=0`).
- **Costes aceptados:** tiempo extra en CPU (varias veces la duración del audio), una dependencia opcional pesada y una
  atribución de hablante aproximada en habla simultánea.
