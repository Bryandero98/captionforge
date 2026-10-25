// Preferencias NO sensibles de este navegador (v1.3.0, iniciativa 2). Una lista blanca de enums y booleanos, versionada, con lectura
// estricta: lo que no es de la lista se descarta campo a campo y se usa el valor por defecto. Nunca se guardan claves, URL base, modelos
// de claves propias, nombres de archivo ni duraciones. El modo (rápido o control total) tampoco: siempre se abre en rápido.
//
// Todas las funciones de almacenamiento son tolerantes: modo privado, datos bloqueados o cuota llena no deben romper la página.

import { BURN_TEMPLATES } from "./burn-options.js";

export const PREFS_KEY = "cf-prefs";
const VERSION = 1;
/** Más que esto no es una preferencia: es un dato ajeno o manipulado, y se ignora entero. */
const MAX_CHARS = 2048;

const MODELS = /** @type {const} */ (["base", "small", "medium"]);
const FORMATS = /** @type {const} */ (["classic", "vertical"]);
const LANGUAGE = /^[a-z]{2,3}$/;

/**
 * @typedef {{
 *   v: 1, autoProfile: boolean, modelSize: "base" | "small" | "medium", sourceLanguage: string, translateTo: string,
 *   cleanAudio: boolean, diarize: boolean, burnFormat: "classic" | "vertical", burnTemplate: string, burnKaraoke: boolean, autoBurn: boolean,
 * }} Prefs
 */

/** @type {Readonly<Prefs>} */
const DEFAULTS = Object.freeze({
  v: VERSION,
  autoProfile: true,
  modelSize: "small",
  sourceLanguage: "",
  translateTo: "",
  cleanAudio: false,
  diarize: false,
  burnFormat: "classic",
  burnTemplate: "bold-pop",
  burnKaraoke: false,
  autoBurn: false,
});

/** Valores por defecto (los de siempre: lo que obtiene quien nunca abre «Control total»). @returns {Readonly<Prefs>} */
export const defaultPrefs = () => DEFAULTS;

/** @param {unknown} value @param {readonly string[]} allowed @param {string} fallback */
const oneOf = (value, allowed, fallback) => (typeof value === "string" && allowed.includes(value) ? value : fallback);
/** @param {unknown} value @param {boolean} fallback */
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
/** @param {unknown} value */
const language = (value) => (typeof value === "string" && LANGUAGE.test(value) ? value : "");

/**
 * Normaliza cualquier objeto a unas preferencias válidas. No lanza.
 * @param {unknown} input
 * @returns {Prefs}
 */
function normalize(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULTS };
  const source = /** @type {Record<string, unknown>} */ (input);
  if (!Object.hasOwn(source, "v") || source.v !== VERSION) return { ...DEFAULTS };
  const own = (/** @type {string} */ key) => (Object.hasOwn(source, key) ? source[key] : undefined);
  return {
    v: VERSION,
    autoProfile: bool(own("autoProfile"), DEFAULTS.autoProfile),
    modelSize: /** @type {Prefs["modelSize"]} */ (oneOf(own("modelSize"), MODELS, DEFAULTS.modelSize)),
    sourceLanguage: language(own("sourceLanguage")),
    translateTo: language(own("translateTo")),
    cleanAudio: bool(own("cleanAudio"), DEFAULTS.cleanAudio),
    diarize: bool(own("diarize"), DEFAULTS.diarize),
    burnFormat: /** @type {Prefs["burnFormat"]} */ (oneOf(own("burnFormat"), FORMATS, DEFAULTS.burnFormat)),
    burnTemplate: oneOf(own("burnTemplate"), BURN_TEMPLATES, DEFAULTS.burnTemplate),
    burnKaraoke: bool(own("burnKaraoke"), DEFAULTS.burnKaraoke),
    autoBurn: bool(own("autoBurn"), DEFAULTS.autoBurn),
  };
}

/**
 * Lee el texto guardado. Texto ausente, ilegible, demasiado grande o de otra versión: valores por defecto.
 * @param {string | null | undefined} raw
 * @returns {Prefs}
 */
export function parsePrefs(raw) {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > MAX_CHARS) return { ...DEFAULTS };
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Texto a guardar: solo la lista blanca, ya normalizada (lo inválido vuelve a su valor por defecto). @param {unknown} prefs */
export function serializePrefs(prefs) {
  return JSON.stringify(normalize(prefs && typeof prefs === "object" ? { ...prefs, v: VERSION } : null));
}

/** @param {Pick<Storage, "getItem"> | null | undefined} storage @returns {Prefs} */
export function loadPrefs(storage) {
  try {
    return parsePrefs(storage ? storage.getItem(PREFS_KEY) : null);
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {Pick<Storage, "setItem"> | null | undefined} storage @param {unknown} prefs @returns {boolean} si se pudo guardar */
export function savePrefs(storage, prefs) {
  try {
    if (!storage) return false;
    storage.setItem(PREFS_KEY, serializePrefs(prefs));
    return true;
  } catch {
    return false;
  }
}

/** ¿Hay algo guardado? (la persona ya ajustó «Control total» alguna vez). @param {Pick<Storage, "getItem"> | null | undefined} storage */
export function hasStoredPrefs(storage) {
  try {
    const raw = storage ? storage.getItem(PREFS_KEY) : null;
    return typeof raw === "string" && raw !== "";
  } catch {
    return false;
  }
}

/** Borra solo la clave de preferencias (las demás —clave de API, idioma, historial— no se tocan). @param {Pick<Storage, "removeItem"> | null | undefined} storage */
export function clearPrefs(storage) {
  try {
    storage?.removeItem(PREFS_KEY);
  } catch {
    // sin almacenamiento no hay nada que borrar
  }
}
