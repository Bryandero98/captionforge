# ADR 0022: URL base propia para proveedores de IA compatibles con OpenAI

- Estado: aceptado (orden del Tech Lead, Issue #14)
- Fecha: 2026-10-24
- Sustituye: el punto 9 del [ADR 0020](0020-ia-avanzada-y-claves-externas-byok.md) («sin URL base personalizada del proveedor»)

## Contexto
El ADR 0020 fijó los hosts de los proveedores en el código para que ni un payload ni una variable de entorno pudieran enviar la clave del
espacio a un servidor ajeno (SSRF). Eso deja fuera a cualquier IA con API de chat compatible con OpenAI que no sea OpenAI: DeepSeek,
Gemini (capa compatible), Groq, OpenRouter, Abacus o un servidor propio.

## Decisión
La clave externa de OpenAI admite un campo opcional `baseUrl`. Si el Dueño lo da, el worker usa ese host en lugar del de OpenAI; si no,
nada cambia.

1. **Dónde vive:** columnas nuevas y nulas en `TenantExternalKey`: `baseUrlCiphertext` (la URL cifrada) y `baseUrlHost` (solo el nombre
   del host, para mostrarlo). La API nunca devuelve la URL completa.
2. **Cifrado:** el mismo AES-256-GCM de la clave. El dato adicional autenticado (AAD) incluye la clave de la fila y un separador de
   dominio, de modo que la URL no descifra si se copia a otra fila o se usa como si fuera la clave.
3. **Validación en la API (al guardar):** solo `https:`; sin usuario, contraseña, consulta ni fragmento; hasta 2048 caracteres; el host
   no puede ser una IP literal, un nombre local (`localhost`, `.local`, `.internal`, `.localhost`) ni resolver por sintaxis a un rango
   privado, de bucle, enlace local, de metadatos o compartido (CGNAT). Errores con código `invalid_base_url`, sin repetir lo recibido.
4. **Validación en el worker (al usarla):** se resuelve el DNS y se rechaza si alguna dirección es no pública (cubre DNS rebinding y
   nombres públicos que apuntan a la red interna). Sin redirecciones ni proxies del entorno (ya es así en `ProviderHttp`).
5. **Contrato:** el trabajo de traducción sigue declarando `provider: "openai"`. La URL no viaja por Redis ni por `Job.options`; el
   worker la recibe junto a la clave por el canal interno (`{ key, baseUrl? }`).
6. **Privilegios:** el Dueño es el único que la gestiona; `cf_worker` sigue sin permisos sobre la tabla.

## Ampliaciones aprobadas por el Tech Lead
- **Modelo opcional (`model`)**: texto plano en la fila (no es un secreto), con el formato `[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}`. Viaja al
  worker junto a la clave por el canal interno. Sin él se usa `gpt-4o-mini`. Cualquier miembro del espacio ve el host y el modelo
  (`GET /v1/workspaces/current/ai-config`), nunca la URL: la confirmación de gasto los muestra.
- **`ALLOW_PRIVATE_BASE_URLS`** (apagada por defecto; la leen el API y el worker; un valor ambiguo hace fallar el arranque): acepta
  URL base de la red local o privada, también por http (Ollama, vLLM). Siguen prohibidos siempre los metadatos de nube y el enlace
  local (169.254.0.0/16, fe80::/10), las direcciones sin especificar, de multidifusión o reservadas, y la IPv4 mapeada en IPv6.
- **Guardia del worker**: antes de CADA petición (reintentos incluidos) resuelve el DNS y aborta el trabajo sin enviar la clave si
  alguna respuesta es no permitida. Devuelve un `ResolvedTarget` inmutable (host, puerto, IP validada, esquema).
- **IP fijada en la conexión** (cierre del TOCTOU / DNS rebinding, Issue #13): `PinnedAsyncTransport` (`pinned_transport.py`) abre el socket
  TCP únicamente contra `ResolvedTarget.ip`. La URL, la cabecera Host, el pool y el SNI / verificación del certificado conservan el nombre
  original (no se usa `verify=False` ni se reescribe la URL con la IP). Cualquier otro host o puerto se rechaza sin tocar la red, y no hay
  conexiones reutilizadas entre intentos: cada reintento resuelve, valida y conecta de nuevo. `httpx` y `httpcore` están fijados a un rango
  estrecho porque el backend de red de `httpcore` es la costura que se sustituye (`tests/test_pinned_transport.py` lo vigila con servidores TLS reales).

## Consecuencias
- Cualquier proveedor compatible con OpenAI funciona sin cambiar código. El modelo se elige con el campo opcional `model`; sin él se usa `gpt-4o-mini`.
- Una URL elegida por una persona es una superficie nueva: las defensas 3 y 4 son obligatorias y tienen pruebas propias.
- `ALLOW_PRIVATE_BASE_URLS` (modelos locales) está aprobado y apagado por defecto: quien lo enciende acepta que el worker alcance su red privada.
- La migración es aditiva: las claves existentes siguen funcionando sin `baseUrl`.
