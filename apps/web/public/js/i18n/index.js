// Traducción mínima: tablas planas por idioma y sustitución de {parámetros} en una sola pasada, de modo que un
// valor con llaves o con HTML no se reinterpreta nunca (los textos se pintan siempre con textContent).

import { messages } from "./messages.js";

export const SUPPORTED_LANGS = /** @type {const} */ (["es", "en", "pt", "fr", "de", "it"]);
/** Idiomas con texto escrito y revisado por una persona; el resto es traducción automática pendiente de revisión nativa. */
export const REVIEWED_LANGS = /** @type {readonly string[]} */ (["es", "en"]);
const FALLBACK = "es";

/** @param {unknown} value @returns {value is typeof SUPPORTED_LANGS[number]} */
function isSupported(value) {
  return typeof value === "string" && /** @type {readonly string[]} */ (SUPPORTED_LANGS).includes(value);
}

/** @returns {(key: string, params?: Record<string, string | number>) => string} */
export function createTranslator(/** @type {string} */ lang) {
  const table = isSupported(lang) ? messages[lang] : messages[FALLBACK];
  return (key, params = {}) => {
    const text = table[key] ?? messages[FALLBACK][key] ?? key;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
  };
}

/** Idioma guardado si es válido; si no, el primero del navegador que conozcamos (la región se ignora); si no, español. */
export function detectLang(/** @type {string | null | undefined} */ stored, /** @type {readonly string[] | undefined} */ preferred) {
  if (isSupported(stored)) return stored;
  for (const tag of preferred ?? []) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (isSupported(base)) return base;
  }
  return FALLBACK;
}
