import { loadApiKey } from "./api/auth.js";
import { readConfig } from "./config.js";
import { createApp } from "./ui/app.js";

const config = readConfig(document);
// La clave de API se resuelve ANTES de arrancar la interfaz: sus primeras peticiones (capacidades, historial) ya la llevan.
let storage = null;
try {
  storage = window.localStorage;
} catch {
  // localStorage inaccesible (modo privado o datos bloqueados): se usa solo la clave del servidor.
}
await loadApiKey({ baseUrl: config.baseUrl, storage });

createApp({ doc: document, win: window, config });
