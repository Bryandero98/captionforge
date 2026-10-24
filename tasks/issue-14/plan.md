# Plan del Issue #14: Multi-LLM (baseUrl propia) y soporte universal de audio

Rama: `feat/issue-14-audio-multillm` (desde `main` en v1.0.1). Va en `tasks/issue-14/` y no en `tasks/plan.md` porque el plan del Issue #13 (estilos dinámicos, parte 2) sigue con tareas abiertas.
Reglas: rojo → verde, verificación local (una suite del API a la vez), commits por tarea, PR solo cuando lo ordene el Tech Lead.
**Orden de ejecución acordado:** solo la Fase 1 y, dentro de ella, hasta terminar la base de datos y el API (backend); después se reporta.

## Resumen
Dos vectores de crecimiento:
1. **Multi-LLM:** cualquier proveedor con API de chat compatible con OpenAI (DeepSeek, Gemini, Groq, OpenRouter, Abacus, servidores propios) mediante un campo opcional `baseUrl` en la clave externa de OpenAI.
2. **Audio universal:** aceptar MP3, WAV, M4A y OGG; la interfaz muestra un reproductor de audio; el doblaje devuelve `.mp3` y no ofrece mezcla con video.

## Decisiones de arquitectura (Fase 1)
| # | Decisión | Motivo |
|---|---|---|
| D1 | `baseUrl` es **opcional** y vive en la fila `TenantExternalKey` junto a la clave. Sin `baseUrl` se usa el host fijo de OpenAI, igual que hoy. | Compatible hacia atrás; ningún trabajo existente cambia. |
| D2 | Se guarda **cifrada** (`baseUrlCiphertext`) con el mismo AES-GCM de la clave, con AAD `tenantId\|provider\|keyVersion\|baseUrl`. La API devuelve solo el **host** (`baseUrlHost`), nunca la URL completa. | Una URL puede llevar rutas internas o tokens; la URL no debe poder moverse a otra fila. |
| D3 | **Revoca ADR 0020 §9** («sin URL base personalizada») con un ADR nuevo, 0022. Riesgos: SSRF y envío de la clave a un servidor ajeno. Mitigaciones obligatorias abajo. | Orden del Tech Lead; el riesgo se acota, no se ignora. |
| D4 | El trabajo de traducción **no cambia de contrato**: sigue diciendo `provider: "openai"`. El worker pide la clave por el canal interno y recibe `{ key, baseUrl? }`. | La URL nunca pasa por Redis ni por `Job.options` (prueba «canario» ampliada). |
| D5 | Los proveedores con nombre del trabajo aparcado en `feat/byok-multi-provider` (DeepSeek, Gemini, Anthropic, Groq, OpenRouter, Abacus) se **integran después** (T8) como atajos con host fijo; `baseUrl` cubre ya cualquier compatible con OpenAI. | Primero lo que pidió el Tech Lead; lo aparcado se reutiliza (adaptador `ChatTranslator`, modelos fijos, tolerancia a JSON en bloque de código). |

### Mitigaciones de SSRF y fuga de la clave (D3)
- Solo `https:`; sin usuario ni contraseña en la URL; sin fragmento ni consulta; longitud máxima 2048; la ruta se normaliza (sin `..`) y el worker le añade `/chat/completions`.
- En la API (al guardar): rechazar IP literales y nombres locales (`localhost`, `*.local`, `*.internal`, `*.localhost`), rangos privados, de bucle, enlace local y de metadatos de nube (`169.254.0.0/16`, `100.64.0.0/10`, `::1`, `fc00::/7`, `fe80::/10`, IPv4 mapeada en IPv6).
- En el worker (al usarla): **resolver el DNS y rechazar** si alguna dirección es no pública (cubre DNS rebinding y nombres públicos que apuntan a la red interna); sin redirecciones; sin proxies del entorno (ya es así en `ProviderHttp`).
- Interruptor `ALLOW_PRIVATE_BASE_URLS` (por defecto `false`) para quien quiera un modelo local (Ollama) en su propia máquina; documentado con su advertencia. Pendiente de aprobación.
- Mensajes de error con código propio (`invalid_base_url`), sin repetir la URL recibida.
- El acceso sigue siendo solo del Dueño; el cambio de `baseUrl` se registra (quién y cuándo, sin la URL).

## Fase 1: tareas (resumen; detalle en `todo.md`)
1. ADR 0022 y este plan.
2. Validador puro de `baseUrl` (API), con pruebas de tabla y de propiedades.
3. Migración aditiva `TenantExternalKey.baseUrlCiphertext` + `baseUrlHost` (nulos por defecto) y `prisma generate`.
4. Cifrado con AAD que incluye la URL y servicio `put/list/reveal` con `baseUrl`.
5. Controlador: cuerpo `{ key, baseUrl? }`; vista con `baseUrlHost`; `reveal` interno entrega `{ key, baseUrl? }`.
6. Pruebas e2e del API (guardar, reemplazar, borrar la URL, rechazos, canario sin fugas en Redis/registros).
   **Punto de parada: reporte al Tech Lead.**
7. (Después) Canal interno y adaptador del worker con guardia de DNS; panel «Claves externas» con el campo; documentación y 6 idiomas.

## Fase 2: audio universal (diseño, sin codificar todavía)
- **Validación:** ampliar los tipos admitidos en `jobs.service.ts` (`audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/x-m4a`, `audio/ogg`) y en `web/js/api/upload.js`; el servidor comprueba además el contenido con `ffprobe` (que haya un flujo de audio) y marca `mediaKind: "audio" | "video"` en el trabajo.
- **Worker:** transcribir ya extrae audio con ffmpeg; un archivo de solo audio salta la parte de video, la forma de onda se calcula igual y el quemado de subtítulos (`burn`) se rechaza con un código claro.
- **Interfaz:** si `mediaKind === "audio"`, se oculta el reproductor de video y se muestra `<audio controls>`; el panel de estilos y quemado se oculta.
- **Doblaje de audio:** flujo Transcripción → Traducción → Doblaje, resultado `.mp3`; la mezcla `duck`/`replace` se desactiva (solo `none`) y el servidor lo valida.
- **Riesgos:** archivos que declaran un tipo falso (se comprueba con ffprobe), duración y tamaño (los topes actuales aplican), accesibilidad del reproductor.

## Riesgos generales y verificación
| Riesgo | Mitigación |
|---|---|
| SSRF o clave enviada a un servidor ajeno | D3 completo; pruebas con IP literales, rangos, DNS que apunta a privado y redirecciones |
| Migración rompe claves existentes | Columnas nulas; prueba con una clave previa sin `baseUrl` |
| Modelo distinto en el proveedor compatible | Hoy el modelo es fijo (`gpt-4o-mini`) y fallaría en la mayoría de compatibles; ver pregunta 1 |
| Fuga de la URL | Cifrada, solo host en vistas, prueba canario en Redis y registros |

## Preguntas abiertas para el Tech Lead
1. Con `baseUrl`, ¿el **modelo** también debe poder elegirse (p. ej. `deepseek-chat`)? Propongo un campo opcional `model` en la misma fila; sin él, DeepSeek y similares fallarían con `gpt-4o-mini`.
2. ¿Permitimos `ALLOW_PRIVATE_BASE_URLS` para modelos locales, apagado por defecto?
