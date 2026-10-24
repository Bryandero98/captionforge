# Tareas del Issue #14

Plan: [plan.md](plan.md). Rojo → verde, una suite del API a la vez, commit por tarea, sin PR hasta orden del Tech Lead.

## Fase 1: Multi-LLM con `baseUrl`
- [x] T1 (S) ADR 0022 (revoca el punto 9 del ADR 0020 con las mitigaciones) y este plan.
- [ ] T2 (S) Validador puro `parseBaseUrl` (https, sin credenciales, sin rangos privados ni nombres locales, longitud, normalización).
  - Verificación: pruebas de tabla + propiedades (nunca acepta una URL con host no público).
- [ ] T3 (S) Migración aditiva `baseUrlCiphertext` y `baseUrlHost` (nulas) en `TenantExternalKey`; `prisma generate`.
  - Verificación: claves antiguas siguen funcionando; privilegios de `cf_api`/`cf_worker` sin cambios.
- [ ] T4 (M) Cifrado con AAD que incluye la URL; `ExternalKeysService.put/list/reveal` con `baseUrl` opcional.
  - Verificación: la URL cifrada no descifra en otra fila; reemplazar sin `baseUrl` la borra.
- [ ] T5 (M) Controlador y canal interno: `PUT` acepta `{ key, baseUrl? }`; las vistas solo traen `baseUrlHost`; `reveal` entrega `{ key, baseUrl? }`.
  - Verificación: `external-keys.e2e` e `internal-key.e2e` ampliadas; canario: ni la clave ni la URL en Redis ni en registros.
- [ ] **Punto de parada:** reporte de pruebas al Tech Lead.
- [ ] T6 (M) Worker: recibir `{ key, baseUrl? }`, guardia de DNS (rechazar direcciones no públicas), usar `baseUrl` en `ChatTranslator`.
- [ ] T7 (M) Panel «Claves externas»: campo opcional de URL base, 6 idiomas, accesible.
- [ ] T8 (S) Integrar los atajos con nombre aparcados en `feat/byok-multi-provider` (DeepSeek, Gemini, Claude, Groq, OpenRouter, Abacus).
- [ ] T9 (S) Documentación ES/EN y README.

## Fase 2: audio universal
- [ ] T10 (M) Validación de tipos de audio en servidor (tipo declarado + `ffprobe`) y cliente; `mediaKind` en el trabajo.
- [ ] T11 (M) Worker: transcribir audio puro; rechazar `burn` sobre audio.
- [ ] T12 (M) UI: `<audio controls>` y ocultar video, estilos y quemado.
- [ ] T13 (M) Doblaje de audio a `.mp3`, mezcla desactivada y validada en el servidor.
- [ ] T14 (S) Documentación, 6 idiomas, e2e en navegador con un MP3 real.
