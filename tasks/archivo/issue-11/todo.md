# Tareas del Issue #11 (IA avanzada y BYOK)

Regla: rojo → verde en cada tarea, un commit por tarea, `graphify update` al terminar, sin `Co-Authored-By`. Plan y decisiones en [plan.md](plan.md). No se empieza ninguna hasta que el Tech Lead apruebe y responda las preguntas abiertas.

## Fase 0: decisiones
- [ ] T0 (XS) Responder las 7 preguntas del plan y escribir el ADR 0020 como "Propuesta".

## Fase 1: cimientos
- [ ] T1 (S) Cifrado y configuración. `APP_SECRET` validado al arrancar; módulo `crypto` (HKDF + AES-256-GCM + AAD); `capabilities.byok`.
  - Criterios: ida y vuelta; texto alterado, AAD distinto o secreto distinto fallan; IV nunca repetido en 10 000 cifrados; sin `APP_SECRET` la función queda apagada, no cifra con un valor por defecto.
  - Verificación: pruebas unitarias nuevas, `npm run typecheck`.
  - Archivos: `src/config/config.ts`, `src/crypto/external-key-crypto.ts`, `src/capabilities/capabilities.controller.ts`, pruebas.
- [ ] T2 (M) Esquema y permisos. `TenantExternalKey`, `JobKind` +`TRANSLATE` +`DUB`; migración con `migrate diff`.
  - Criterios: `cf_worker` sin ningún permiso sobre la tabla; `cf_api` con CRUD; único `(tenantId, provider)`; la migración aplica sobre una base con datos.
  - Verificación: `db-privileges.e2e.spec.ts` ampliado (rojo antes de la migración), `npm run migrate`.
  - Archivos: `prisma/schema.prisma`, migración nueva, `test/db-privileges.e2e.spec.ts`.
- [ ] T3 (M) API de claves externas (alta, lista, borrado, verificación). Solo Dueño por sesión; `no-store`; auditoría.
  - Criterios: la respuesta jamás contiene la clave; Editor, Visor y claves de API reciben 403; formato inválido 400; volcar la tabla no muestra el valor en claro; borrar elimina la fila.
  - Verificación: `external-keys.e2e.spec.ts` (matriz de roles y canario en la base), `roles.e2e.spec.ts`.
  - Archivos: `src/external-keys/*`, `src/app.module.ts`, pruebas.

### Punto de control: cimientos
- [ ] Suite completa verde; `npm run typecheck`; una persona Dueño guarda una clave y la base solo tiene el cifrado.

## Fase 2: canal seguro
- [ ] T4 (M) Listener interno y endpoint de entrega. `INTERNAL_PORT`, `WORKER_INTERNAL_TOKEN`, ruta atada al trabajo.
  - Criterios: sin token o con token malo 401; trabajo no `RUNNING`, de otro tipo o con otro proveedor 403/404; el espacio sale de la fila del trabajo; no existe por el puerto público ni por Caddy; límite de peticiones.
  - Verificación: `internal-key.e2e.spec.ts`; paso de CI que comprueba que `https://localhost/internal/...` da 404 y que el puerto interno no está publicado.
  - Archivos: `src/internal/*`, `src/main.ts`, `docker-compose.yml`, `.github/workflows/monorepo.yml`.
- [ ] T5 (M) Cliente del worker y prueba canario. httpx con tiempos límite, filtro de la clave en toda salida, clave solo en memoria.
  - Criterios: la clave no aparece en Redis (`bull:*`), `Job`, registros del API y del worker ni `/work`; un error del proveedor con la clave dentro no llega al usuario.
  - Verificación: `test_external_key.py`, `leak-canary.e2e.spec.ts`.
  - Archivos: `apps/ai-worker/src/ai_worker/external_key.py`, `config.py`, `logfmt.py`, pruebas.

### Punto de control: canal seguro
- [ ] Suite API + worker verde; canario sin coincidencias; CI de infraestructura verde.

## Fase 3: trabajos
- [ ] T6 (M) Contratos. `translate-job`, `translate-result`, `dub-job`, `dub-result`, códigos `EXTERNAL_*`; regenerar modelos TS y Python.
  - Criterios: `additionalProperties:false`; ningún campo puede llevar la clave; paridad Node/Python.
  - Verificación: `npm run contracts:test` y `python-tests`.
- [ ] T7 (L → dos subtareas) Traducir de punta a punta.
  - T7a (M) Con `argos` (local): API `POST /v1/jobs/:id/translate`, cola, worker, resultado y descarga. Prueba la tubería sin dinero.
  - T7b (M) Con `openai` por BYOK: la clave llega por el canal de T4; traducción por lotes conservando tiempos.
  - Criterios: 409 si hay una en curso o falta la clave; resultado con mismos tiempos y texto nuevo; permisos Editor+.
  - Verificación: `translate.e2e.spec.ts`, `test_translate_job.py` con proveedor falso.
- [ ] T8 (M) Adaptadores de proveedor y degradación. Reintentos acotados, mapeo por estado a `EXTERNAL_*`, tiempos límite.
  - Criterios: 401/402 sin reintento; 429/5xx con espera y tope; cuelgue y JSON roto terminan en `EXTERNAL_TIMEOUT`/`EXTERNAL_UNAVAILABLE`; el contenedor sigue y procesa el siguiente trabajo.
  - Verificación: `test_provider_failures.py` (servidor falso con los 5 modos), prueba de que el mensaje al usuario no contiene texto del proveedor.
- [ ] T9 (L → dos subtareas) Doblar.
  - T9a (M) TTS (`openai`, `elevenlabs`), ajuste de duración con `atempo` acotado, `dub.mp3`, topes de gasto.
  - T9b (M) Mezcla en MP4 (`replace`/`duck`), `overflowSegments`, cancelación y limpieza de `/work`.
  - Verificación: `dub.e2e.spec.ts`, `test_dub.py` con ffmpeg real y TTS falso.

### Punto de control: trabajos
- [ ] Traducir y doblar de punta a punta contra proveedores falsos; fallos con mensaje claro; suite completa verde.

## Fase 4: interfaz
- [ ] T10 (M) Panel "Claves externas" (solo Dueño). Sin repintar el valor; `last4`; reemplazar, borrar, probar; 6 idiomas; accesible.
  - Verificación: `npm test` en web, `byok-browser.e2e.spec.ts`.
- [ ] T11 (M) Paneles Traducir y Doblar con estimación y confirmación de gasto, progreso, errores `EXTERNAL_*` traducidos y descarga.
  - Verificación: pruebas web, e2e de navegador (clics DOM), revisión de textos en los 6 idiomas.

## Fase 5: cierre
- [x] T12 (M) Documentación y operación. ADR 0020 "Aceptada", `architecture_and_security.md`, guías ES/EN, `.env.example`, `start.sh/bat` generan `APP_SECRET` y `WORKER_INTERNAL_TOKEN`, compose (puerto interno, `API_INTERNAL_URL` del worker), CI.
- [x] T13 (XS) Revisión independiente (seguridad, base de datos, fallos silenciosos), `graphify update`, apagar infraestructura, PR único con commits por tarea.

### Punto de control: listo para revisión
- [ ] Todos los criterios cumplidos, CI verde, canario limpio, plan de reversión (migración aditiva, función apagable sin `APP_SECRET`).
