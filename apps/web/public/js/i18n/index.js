// Traducción mínima: tablas planas por idioma y sustitución de {parámetros} en una sola pasada, de modo que un
// valor con llaves o con HTML no se reinterpreta nunca (los textos se pintan siempre con textContent).

import { messages } from "./messages.js";

export const SUPPORTED_LANGS = /** @type {const} */ (["es", "en"]);
const FALLBACK = "es";

/** @returns {(key: string, params?: Record<string, string | number>) => string} */
export function createTranslator(/** @type {string} */ lang) {
  const table = lang === "en" ? messages.en : messages.es;
  return (key, params = {}) => {
    const text = table[key] ?? messages[FALLBACK][key] ?? key;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
  };
}

/** Idioma guardado si es válido; si no, el primero del navegador que conozcamos; si no, español. */
export function detectLang(/** @type {string | null | undefined} */ stored, /** @type {readonly string[] | undefined} */ preferred) {
  if (stored === "es" || stored === "en") return stored;
  for (const tag of preferred ?? []) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base === "es" || base === "en") return base;
  }
  return FALLBACK;
}
