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

## Consecuencias
- Cualquier proveedor compatible con OpenAI funciona sin cambiar código. El modelo sigue fijo hasta que se apruebe un campo `model`.
- Una URL elegida por una persona es una superficie nueva: las defensas 3 y 4 son obligatorias y tienen pruebas propias.
- El interruptor `ALLOW_PRIVATE_BASE_URLS` (modelos locales) queda pendiente de aprobación y apagado por defecto.
- La migración es aditiva: las claves existentes siguen funcionando sin `baseUrl`.
