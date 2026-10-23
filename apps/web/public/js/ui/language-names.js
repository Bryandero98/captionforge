// Nombres de idioma para los selectores: en el idioma de la interfaz si el navegador los conoce, y si no, los del diccionario de Whisper.

import { LANGUAGES } from "../domain/languages.js";

/** @param {string} lang idioma de la interfaz @returns {{ code: string, label: string }[]} */
export function languageNames(lang) {
  let names = null;
  try {
    names = new Intl.DisplayNames([lang], { type: "language" });
  } catch {
    // sin soporte: nombres en inglés
  }
  return LANGUAGES.map(({ code, name }) => {
    let label = name;
    try {
      label = names?.of(code) ?? name;
    } catch {
      // código que Intl no conoce
    }
    return { code, label: label.charAt(0).toLocaleUpperCase(lang) + label.slice(1) };
  }).sort((a, b) => a.label.localeCompare(b.label, lang));
}
