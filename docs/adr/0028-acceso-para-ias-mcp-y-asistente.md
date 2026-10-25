# ADR 0028: Acceso para IAs, servidor MCP local y asistente de la interfaz

- Estado: aceptado (orden del usuario, v1.3.1)
- Fecha: 2026-10-25

## Contexto
La v1.3.0 es potente pero una persona nueva no sabe por dónde empezar, y una IA que se tope con la herramienta no tiene cómo entenderla ni
manejarla. Se quiere lo uno y lo otro sin quitarle capacidad a nadie, y **solo en modo local** (instalación de una persona,
`LOCAL_MODE=true`): en un servidor expuesto (`LOCAL_MODE=false`) nada de esto debe existir.

## Decisión
1. **Instrucciones para IAs**: `GET /llms.txt` (formato llms.txt) y `GET /openapi.json` (OpenAPI 3.1, escrita a mano y corta). Son documentación sin
   datos de nadie, públicas en modo local y **404 con `LOCAL_MODE=false`**. Cada operación que gasta o cambia algo lleva
   `x-requires-user-confirmation: true`.
2. **Servidor MCP local** (`tools/mcp`, stdio, sin dependencias): herramientas de lectura (capacidades, trabajos, subtítulos, calidad, descarga de
   `.srt`), subida de un archivo del equipo y las acciones de **traducir, doblar, quemar, cancelar y editar subtítulos**. Estas cinco **no se ejecutan sin
   `confirmed: true`**; sin él devuelven `NEEDS_USER_CONFIRMATION` y no llaman al servidor. El texto de subtítulos vuelve marcado como dato no confiable. Usa una
   clave de API que crea la persona; un fallo se informa tal cual y no se reintenta.
3. **Asistente en la interfaz**: botón flotante y panel de chat, **removible** (se quita, se vuelve a mostrar desde la barra superior y recuerda la decisión).
   - **Solo conversa.** No se le ofrecen herramientas (`tools`): nada de lo que diga la IA, ni de lo que haya escrito en un archivo, puede ejecutar acciones.
     Las acciones siguen siendo los botones de la página, con su propia confirmación de gasto.
   - **La IA es la de la persona** (DeepSeek, OpenAI, Gemini…, cualquier servicio compatible con OpenAI).
   - **Dónde vive la clave.** En modo local no hay sesión de Dueño, y sin sesión no se pueden guardar «Claves externas» (ADR 0020). Por eso la clave se guarda **solo en el
   navegador** (`localStorage`, clave `cf-assistant`) y viaja en el cuerpo de cada mensaje; **el servidor no la guarda ni la registra**. Quitar el asistente no la borra;
   «Olvidar mi clave» sí.
   - **SSRF (ADR 0022).** La URL base pasa por las mismas reglas que las claves externas (`https`, host público; red privada solo con `ALLOW_PRIVATE_BASE_URLS`). Además la
   llamada se hace con la **IP fijada**: el DNS se resuelve una vez, se rechaza todo si alguna respuesta no está permitida y el socket se abre contra esa misma
   dirección. Sin redirecciones, 60 s y 512 KiB como tope; los errores del proveedor no se repiten al cliente.
4. **Capacidad**: `GET /v1/capabilities` anuncia `assistant: { enabled, allowPrivateBaseUrls }`. Sin `enabled` el botón no existe.

## Consecuencias
- Con `LOCAL_MODE=true` la clave del asistente viaja por la red local en el cuerpo de cada mensaje: si se expone el puerto sin TLS, quien lo vea la ve. Es el mismo
  supuesto de confianza del modo local (quien alcanza el puerto actúa como el espacio). Para exponerlo hay que usar `LOCAL_MODE=false`, y entonces el asistente desaparece.
- El MCP no tiene estado ni credenciales propias: cada ejecución lee `CAPTIONFORGE_URL` y `CAPTIONFORGE_API_KEY`.
- El asistente no sustituye a las acciones de la página: aconseja. Que ejecute acciones por su cuenta quedaría para otra decisión, con confirmación previa en la interfaz.
