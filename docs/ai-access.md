# Acceso para IAs

CaptionForge se puede manejar desde una IA (Claude, ChatGPT, un agente propio…) **en modo local** (`LOCAL_MODE=true`, la predeterminada). Con `LOCAL_MODE=false`
nada de esto existe: las rutas responden 404 y la página no muestra el asistente. Decisión y riesgos: [ADR 0028](adr/0028-acceso-para-ias-mcp-y-asistente.md).

## 1. Que la IA lea las instrucciones

- `http://127.0.0.1:3000/llms.txt`: qué es la herramienta, el flujo típico y las reglas.
- `http://127.0.0.1:3000/openapi.json`: todas las rutas que hacen falta. Las que gastan o cambian algo llevan `x-requires-user-confirmation`.

Una IA con acceso a la web local solo necesita esas dos direcciones y una clave de API (`X-API-Key`).

## 2. Servidor MCP (stdio)

1. Crea una clave de API desde la página (botón **Claves de API**) o usa la `DEFAULT_API_KEY` de tu `.env`.
2. Configura tu cliente MCP (ejemplo para Claude Desktop o Claude Code):

```json
{
  "mcpServers": {
    "captionforge": {
      "command": "node",
      "args": ["C:/ruta/a/captionforge/tools/mcp/bin/captionforge-mcp.mjs"],
      "env": { "CAPTIONFORGE_URL": "http://127.0.0.1:3000", "CAPTIONFORGE_API_KEY": "tu-clave" }
    }
  }
}
```

Herramientas: `get_capabilities`, `list_jobs`, `get_job`, `get_segments`, `get_quality`, `download_srt`, `transcribe_file`, y las que piden permiso:
`translate_job`, `dub_job`, `burn_job`, `cancel_job`, `edit_segments`. Estas últimas **no hacen nada** hasta que la IA vuelve a llamarlas con `confirmed: true`, y solo debe
hacerlo después de que tú digas que sí.

## 3. Asistente dentro de la página

En modo local aparece el botón **Asistente** (abajo a la derecha). Abre **Mi IA**, elige el servicio, pega tu clave de API y pulsa **Guardar en este navegador**.
La clave se queda en tu navegador y viaja con cada mensaje a tu propio servidor, que no la guarda. El asistente solo conversa: las acciones las haces con los botones.
**Quitar el asistente** lo oculta (vuelve con **Mostrar el asistente**, arriba); **Olvidar mi clave** la borra del navegador.
