# ADR 0002: Los archivos se referencian por `bucket` + `objectKey`, no por URL

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
El API necesita decirle al worker dónde está el video de entrada y dónde dejar los resultados.
Una opción habitual es una URL prefirmada de S3 dentro del mensaje.

## Decisión
Los mensajes llevan `{ bucket, objectKey }`. El worker accede con sus propias credenciales de
mínimo privilegio (lectura y escritura bajo `jobs/*`). El patrón de `objectKey` exige
`jobs/<uuid>/…` con segmentos `[A-Za-z0-9_-]`, y por tanto rechaza `..`, rutas absolutas y
claves fuera de `jobs/`.

## Alternativas consideradas

### URL prefirmada en el mensaje
- Pro: el worker no necesita credenciales.
- Contra: la URL es un secreto que viaja por Redis, aparece en logs y trazas, caduca (un trabajo
  que espera en cola puede encontrarla vencida) y su host queda fijado en el mensaje (riesgo de
  SSRF si alguna vez se acepta una URL externa).
- Rechazada: mueve el problema de seguridad al mensaje.

### Ruta de disco compartida
- Contra: obliga a que API y worker compartan volumen; impide escalar el worker en otra máquina.
- Rechazada.

## Consecuencias
- El worker tiene credenciales S3 propias, acotadas por política a `jobs/*` y sin permiso de
  borrado (`docker/s3/init-bucket.sh`, comprobado por `docker/verify-infra.sh`).
- Nada sensible viaja por la cola: un volcado de Redis no da acceso a los archivos.
- Los resultados se devuelven también como `objectKey`; el cliente descarga a través del API.
