# ADR 0023: audio puro como entrada (MP3, WAV, M4A, OGG y FLAC)

- Estado: aceptado (Issue #14, Fase 2)
- Relacionado: [ADR 0020](0020-ia-avanzada-y-claves-externas-byok.md) (traducir y doblar), [ADR 0022](0022-url-base-propia-para-proveedores-de-ia.md)

## Contexto

CaptionForge solo aceptaba video. Un podcast, una nota de voz o una grabación de llamada son audio puro, y el pipeline ya trabaja
sobre el audio: lo primero que hace el worker es extraer una pista WAV de 16 kHz con `ffmpeg -vn`, y Whisper, la traducción y el
doblaje no usan la imagen. Lo único que necesita imagen es el quemado de subtítulos y la mezcla del doblaje dentro de un `.mp4`.

## Decisión

1. **Formatos.** Se aceptan MP3, WAV, M4A, OGG y FLAC, con los nombres de tipo que mandan los navegadores (`audio/mpeg`, `audio/mp3`,
   `audio/wav`, `audio/x-wav`, `audio/wave`, `audio/mp4`, `audio/x-m4a`, `audio/m4a`, `audio/ogg`, `audio/flac`, `audio/x-flac`). La lista
   vive en tres sitios que deben coincidir: el enum de `contentType` de `transcribe-job.v1.json` (el contrato, de donde salen los tipos
   de TypeScript y de Python), `apps/api-gateway/src/jobs/media-kind.ts` y `apps/web/public/js/domain/media.js`. Otros audios (AAC suelto,
   WMA, WebM de audio) se rechazan con 415.
2. **`mediaKind` sin migración.** El trabajo expone `mediaKind: "audio" | "video"`, derivado del `contentType` ya guardado. Lo desconocido
   o antiguo cuenta como video, así que ningún trabajo previo cambia de comportamiento.
3. **Reglas con audio, validadas en el API antes de crear o encolar nada:** el quemado de subtítulos responde `400 burn_not_available_for_audio`
   y un doblaje con mezcla `replace` o `duck` responde `400 mix_not_available_for_audio`. Solo existe la salida `none` (pista `.mp3`).
4. **Defensa en el worker.** Si un trabajo llegara por otro camino, el quemado falla con `BURN_NEEDS_VIDEO` y la mezcla con `MIX_NEEDS_VIDEO`
   (esta última antes de pedir nada al proveedor, para no gastar). `has_video_stream` mira los flujos con `ffmpeg -i` e ignora la carátula
   (`attached pic`) de un MP3, M4A o FLAC con portada, que no es imagen en movimiento.
5. **La extracción de audio no cambia.** `-vn` sobre un archivo que ya es audio funciona sin errores: no hace falta un desvío. Se prueba con los
   cinco formatos reales. Un archivo que no es audio (extensión falsa) sigue terminando en `FFMPEG_FAILED`.
6. **Escuchar el original.** Para editar subtítulos con un audio, el panel de resultados muestra un `<audio controls>` estándar. El audio se
   pide como artefacto `source` (`GET /v1/jobs/:id/artifacts/source`, con Range), que **solo** existe para una transcripción de audio
   terminada; el original de un video no se sirve. Si caducó o pesa más de 256 MiB, el reproductor no aparece y lo demás sigue funcionando.
7. **Interfaz.** Con un audio no hay formulario de quemado ni reproductor de video, y el menú de salida del doblaje queda desactivado con la
   única opción «Solo la pista de voz (.mp3)». Si el navegador declara un `.m4a` como `video/mp4`, el cliente lo envía como `audio/mp4`
   (la extensión manda cuando contradice a un tipo de video).

## Consecuencias

- El servidor confía en el tipo declarado para decidir `mediaKind`, igual que ya hacía para aceptar video; el contenido real lo valida
  `ffmpeg` en el worker (un archivo que no es audio ni video falla con `FFMPEG_FAILED`). No se añadió `ffprobe` a la imagen del API.
- Un `.m4a` subido con tipo de video por otro cliente (por ejemplo `curl`) se tratará como video: se ofrecería quemado, que fallaría en el
  worker con `BURN_NEEDS_VIDEO`. Es un fallo claro y sin gasto, no un riesgo de seguridad.
- El artefacto `source` amplía lo que se puede leer de un trabajo, pero sigue aislado por tenant (404 para otro espacio) y limitado a audio.

## Pruebas

Contrato (ejemplos válidos e inválidos), `media-kind.spec.ts`, `audio.e2e.spec.ts` (aceptación, 415, quemado, mezcla, `source`), `test_audio_input.py`
(los cinco formatos con ffmpeg real, quemado y mezcla rechazados, doblaje a `.mp3`), pruebas del cliente y e2e en navegador con un WAV y un MP3 reales.
