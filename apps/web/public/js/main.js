import { resolveAccess } from "./api/access.js";
import { readConfig } from "./config.js";
import { createTranslator, detectLang } from "./i18n/index.js";
import { createAccount } from "./ui/account.js";
import { createApp } from "./ui/app.js";

const config = readConfig(document);
// La clave de API se resuelve ANTES de arrancar la interfaz: sus primeras peticiones (capacidades, historial) ya la llevan.
let storage = null;
try {
  storage = window.localStorage;
} catch {
  // localStorage inaccesible (modo privado o datos bloqueados): se usa solo la clave del servidor.
}
// Cómo entra la página al API: clave local, sesión iniciada o pantalla de entrada (api/access.js).
const access = await resolveAccess({ baseUrl: config.baseUrl, storage });

/** @type {ReturnType<typeof createAccount> | null} */
let account = null;
const stored = (() => {
  try {
    return window.localStorage.getItem("cf-lang");
  } catch {
    return null;
  }
})();
account = createAccount({ doc: document, win: window, baseUrl: config.baseUrl, access, t: createTranslator(detectLang(stored, window.navigator.languages)) });
createApp({ doc: document, win: window, config, onTranslate: (t) => account?.refresh(t) });
