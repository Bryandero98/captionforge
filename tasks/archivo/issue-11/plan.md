# Plan de implementación: Issue #11, IA avanzada y BYOK

Rama: `feat/issue-11-ai-byok` (local; GitHub sin conexión al crearla). Estado: **plan para aprobación, sin código ni migraciones**.
Tareas en [todo.md](todo.md). ADR previsto: 0020 (Propuesta hasta que el Tech Lead apruebe).

## Resumen

Dos módulos nuevos que se ejecutan como **trabajos hijos** de una transcripción terminada (igual que el quemado):

- **Traducir** (`TRANSLATE`): lee `segments.json`, conserva los tiempos y escribe los segmentos traducidos. Proveedores: `argos` (local, ya existe en el código heredado, no necesita clave) y `openai` (BYOK).
- **Doblar** (`DUB`, texto a voz): lee los segmentos (originales o traducidos), pide la voz al proveedor, ajusta la duración de cada frase y entrega un audio y, opcionalmente, el video con el audio mezclado. Proveedores: `openai`, `elevenlabs` (BYOK). No hay TTS local: el objetivo es no gastar VRAM.

**BYOK**: cada espacio guarda sus claves de proveedor cifradas. La clave **nunca** entra en Redis, en `Job.options`, en `Job.result`, en los registros ni en un mensaje de error. El worker la pide al API en el momento de usarla, por un canal interno.

## Hechos del código que condicionan el diseño

| Hecho | Consecuencia |
|---|---|
| El worker habla directo con PostgreSQL con `cf_worker` y permisos por columna (ADR 0003) y **no tiene cliente del API** | Hay que añadirle uno (httpx + `API_INTERNAL_URL`); la tabla de claves **no** se concede a `cf_worker`: la base misma impide que el worker lea el cifrado |
| `APP_SECRET` no existe; los secretos viven en `.env` y los genera `start.sh/bat` | Variable nueva, obligatoria solo para activar BYOK; sin ella la función se apaga (`capabilities.byok.enabled=false`), nunca cifra con un valor por defecto |
| Contratos JSON Schema → modelos TS y Python con prueba de paridad (ADR 0001) | Los dos tipos de trabajo y los códigos de error nuevos van primero al contrato |
| `ErrorCode` es un enum cerrado (`FFMPEG_*`, `INTERNAL`...) | Se añaden códigos `EXTERNAL_*`; la interfaz los traduce en 6 idiomas |
| El quemado ya modela "hijo de una transcripción" (`parentJobId`, 409 si ya hay uno en curso, ETag de segmentos) | Se reutiliza el patrón para TRANSLATE y DUB |
| La traducción ya existe dentro de la transcripción (`translateTo`, Argos) | No se toca; TRANSLATE es el mismo motor como paso aparte (se puede traducir sin repetir Whisper) |
| Un solo hueco de ejecución para todo (semáforo 1) | Los trabajos que solo esperan a una API externa usan un hueco aparte para no bloquear Whisper |
| Caddy publica todo el API menos `/metrics`; las métricas ya usan otro puerto interno (ADR 0018) | El canal del worker va en un **listener interno propio**, que Caddy ni conoce |

## Decisiones de arquitectura

### 1. Esquema (Prisma)

`TenantExternalKey`: `id`, `tenantId` (FK Restrict), `provider` (`openai` | `elevenlabs`), `ciphertext` (texto `v1.<iv>.<tag>.<datos>` en base64url), `keyVersion` (int), `last4`, `createdBy` (FK SetNull, solo auditoría), `createdAt`, `rotatedAt`. Único `(tenantId, provider)`: una clave por proveedor y espacio.
Permisos (migración construida con `migrate diff`, como la anterior): `cf_api` SELECT/INSERT/UPDATE/DELETE; `cf_worker` **ninguno**. Prueba en `db-privileges` que lo fija.
`JobKind` gana `TRANSLATE` y `DUB`. `Job.options` guarda `{provider, ...}` sin secretos.

### 2. Cifrado

- AES-256-GCM, IV aleatorio de 96 bits por cifrado, etiqueta de 128 bits.
- La clave de cifrado se **deriva** de `APP_SECRET` con HKDF-SHA256 y contexto `captionforge/external-key/v1`; el secreto crudo no se usa como clave.
- **AAD** = `tenantId|provider|keyVersion`: un cifrado copiado a otra fila (otro espacio u otro proveedor) no descifra.
- `APP_SECRET` ≥ 32 bytes, validado al arrancar. Perderlo = perder las claves guardadas (la persona las vuelve a pegar); se documenta.
- Rotación: `keyVersion` permite `APP_SECRET_PREVIOUS` para descifrar y re-cifrar (comando aparte). Pregunta abierta 6.

### 3. API de gestión (sesión de navegador, solo Dueño)

- `PUT /v1/workspaces/current/external-keys/:provider` `{key}`: valida formato por proveedor, cifra y guarda. `GET` (lista: proveedor, `last4`, fechas; **nunca** la clave), `DELETE` (borrado real, no marca). `POST .../:provider/verify` opcional: una llamada barata al proveedor (OpenAI `GET /v1/models`, ElevenLabs `GET /v1/user`) con tiempo límite.
- Roles: el Dueño gestiona; el Editor **usa** las claves lanzando trabajos; el Visor no lanza trabajos. Las claves de API (rol Editor estático) pueden lanzar trabajos pero **no** ver ni gestionar claves externas.
- Respuestas con `Cache-Control: no-store`. Registro de auditoría de alta/baja/uso sin valores.
- La clave pertenece al espacio, no a quien la pegó: si esa persona deja de ser Dueño, la clave sigue (a diferencia de las claves de API del #10). Pregunta abierta 5.

### 4. Canal seguro al worker

- **Listener interno separado** (`INTERNAL_PORT`, modelo de `metrics-server.ts`): no se publica en el host ni pasa por Caddy. Mismo proceso del API, otro puerto.
- `POST /internal/v1/jobs/:jobId/external-key` `{provider}`.
- Autenticación: secreto de servicio **propio** `WORKER_INTERNAL_TOKEN` (≥ 32 bytes), comparación en tiempo constante. Pregunta abierta 1: el Tech Lead sugirió "la API_KEY del sistema"; `DEFAULT_API_KEY` es una clave de **espacio** con permisos de espacio, no un secreto de servicio, y reutilizarla daría a quien la filtre más de lo necesario.
- **Atado al trabajo**: el espacio sale de la fila del trabajo, nunca del cuerpo; el trabajo debe estar `RUNNING`, ser `TRANSLATE`/`DUB`, y el `provider` pedido debe ser el que declara `Job.options.provider`. Con un token filtrado solo se obtienen claves de trabajos en marcha y solo del proveedor que ese trabajo usa.
- `Cache-Control: no-store`, límite de peticiones, métrica y registro del evento (jobId, proveedor, resultado; jamás el valor).
- Transporte: red interna de Docker (HTTP). El API local escucha en `127.0.0.1`. Riesgo residual documentado (quien esté dentro de la red de contenedores).

### 5. Cero fugas en Redis

- El payload de BullMQ lleva solo `provider` y opciones (voz, idioma, modelo). Los esquemas ya tienen `additionalProperties: false`; se añade una prueba que lo exige.
- **Prueba canario**: se guarda una clave `sk-canario-…`, se lanza un trabajo completo y se busca la cadena en todas las claves `bull:*` de Redis, en las tablas `Job`/`TenantExternalKey` (solo debe aparecer el cifrado, y no en claro), en los registros del API y del worker y en `/work`. Cero coincidencias.
- En el worker: la clave vive en memoria durante el trabajo; no va a disco, a variables de entorno de subprocesos ni a argumentos de `ffmpeg`; `repr=False` en la estructura; filtro que sustituye la clave en cualquier mensaje o traza antes de registrar o guardar.
- Los errores del proveedor **no** se copian al usuario: OpenAI incluye fragmentos de la clave en "Incorrect API key provided". Se traducen por estado/código a mensajes propios.

### 6. Degradación elegante

Códigos nuevos en `ErrorCode`: `EXTERNAL_KEY_MISSING`, `EXTERNAL_AUTH_FAILED` (clave inválida o revocada), `EXTERNAL_RATE_LIMITED`, `EXTERNAL_QUOTA_EXCEEDED` (saldo agotado), `EXTERNAL_TIMEOUT`, `EXTERNAL_UNAVAILABLE`.
- 401/403/402 no se reintentan. 429 y 5xx: hasta 3 reintentos con espera exponencial y `Retry-After`, con tope de tiempo total.
- Tiempos límite de conexión (10 s) y de lectura (60 s) por llamada y un tope total por trabajo.
- Todo error pasa por `classify`; el worker marca el trabajo `FAILED` con mensaje en español y sigue vivo para el siguiente. Prueba: un servidor falso devuelve 429, 402, 500, cuelgue y JSON roto; el trabajo termina `FAILED` con el código esperado y un segundo trabajo se procesa después.
- Si falta la clave al crear el trabajo, el API responde `409 external_key_missing` antes de encolar (falla rápido, sin gastar nada); el worker lo vuelve a comprobar.

### 7. Control del gasto (el dinero es de la persona usuaria)

Tope de caracteres y de segmentos por trabajo (configurable), estimación visible en la interfaz antes de lanzar ("≈ N caracteres") y confirmación explícita. Las cuotas existentes (`TENANT_MAX_QUEUED_JOBS`) siguen aplicando. Sin URL base personalizada del proveedor en v1 (SSRF y exfiltración de la clave a un servidor ajeno).

### 8. Doblaje: salidas

`dub.mp3` (pista de voz ajustada a los tiempos) y, si se pide, `dubbed.mp4` con `mix: replace | duck` (audio original bajado). Ajuste de cada frase con `atempo` acotado (0.85–1.25); si no cabe, se recorta el silencio y se avisa en el resultado (`overflowSegments`). Resultado validado por contrato.

### 9. Interfaz

- Ajustes del espacio → "Claves externas" (solo Dueño): campo `password` con `autocomplete="off"`, muestra `…last4`, Reemplazar / Borrar / Probar; el valor jamás se vuelve a pintar.
- Resultados → "Traducir" (Local o proveedor; deshabilitado con explicación si falta la clave) y "Doblar" (proveedor, voz, mezcla), con progreso, errores `EXTERNAL_*` traducidos y descarga.
- `capabilities` suma `byok` y la lista de proveedores. 6 idiomas, `<dialog>` para confirmar gasto, DOM clicks en e2e (lección del #10).

## Orden y puntos de control

Cimientos (cifrado, esquema, CRUD) → canal seguro → contratos → TRANSLATE con Argos (prueba la tubería sin dinero ni claves) → proveedores y degradación → DUB → interfaz → documentación. Los puntos de control están en [todo.md](todo.md).

## Riesgos y mitigaciones (pre-mortem)

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Volcado de la base + `APP_SECRET` filtrados | Alto | HKDF + AAD, `APP_SECRET` fuera de la base y de los respaldos, documentado; `cf_worker` sin acceso a la tabla |
| `WORKER_INTERNAL_TOKEN` filtrado | Medio | Atado a trabajos `RUNNING`, solo el proveedor del trabajo, listener no publicado, límite de peticiones |
| Clave filtrada por un error del SDK/proveedor | Alto | No se reenvían mensajes del proveedor; filtro de la clave en toda salida; prueba canario |
| Redis/log con la clave | Alto | Payload sin secretos por contrato + prueba canario sobre Redis, base, registros y `/work` |
| Doblaje largo agota el saldo a mitad | Medio | Tope por trabajo, estimación y confirmación, `EXTERNAL_QUOTA_EXCEEDED` claro; reanudar queda para v1.1 |
| TTS bloquea Whisper | Medio | Hueco de ejecución aparte para trabajos de red |
| Perder `APP_SECRET` | Medio | Documentado; las claves se vuelven a pegar; rotación con `keyVersion` |
| Proveedor cambia su API | Bajo | Adaptadores finos por proveedor con pruebas contra servidor falso |

## Preguntas abiertas (necesito respuesta antes de codificar)

1. **Secreto del canal interno**: `WORKER_INTERNAL_TOKEN` dedicado (recomendado) o la `DEFAULT_API_KEY`.
2. **Listener interno en otro puerto** (recomendado) o ruta `/internal` en el puerto público bloqueada en Caddy.
3. **Proveedores de v1**: OpenAI (traducir y TTS), ElevenLabs (TTS), Argos local (traducir). ¿Alguno más?
4. **Salida del doblaje**: audio + mezcla opcional en MP4 (recomendado) o solo audio.
5. **Dueño de la clave**: la clave es del espacio y la gestiona solo el Dueño (recomendado). ¿O también el Editor?
6. **Rotación de `APP_SECRET`**: incluir `APP_SECRET_PREVIOUS` y el comando de re-cifrado en este issue o dejarlo para después (recomendado: dejar el campo `keyVersion` y el comando para después).
7. **Topes de gasto** por defecto: 50 000 caracteres y 1 000 segmentos por trabajo.
