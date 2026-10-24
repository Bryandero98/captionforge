// Lo que cuenta para el gasto en un proveedor externo: caracteres de texto. Es una estimación («≈»): el API aplica sus propios topes.

/** Caracteres (puntos de código) de los subtítulos, sin los espacios de los extremos de cada uno. @param {readonly ({ text?: unknown } | null)[]} segments */
export function characterCount(segments) {
  let total = 0;
  for (const segment of segments) {
    if (segment === null || typeof segment !== "object" || typeof segment.text !== "string") continue;
    total += Array.from(segment.text.trim()).length;
  }
  return total;
}

/** Número con los separadores del idioma de la interfaz (12.500 en español, 12,500 en inglés). */
export function formatCount(/** @type {number} */ value, /** @type {string} */ lang) {
  try {
    return new Intl.NumberFormat(lang).format(value);
  } catch {
    return String(value);
  }
}

/** Caracteres por token que se usan para estimar (orientativo: varía según el idioma y el modelo). */
export const CHARS_PER_TOKEN = 4;

/** Tokens aproximados de un texto de `characters` caracteres; nunca negativo ni NaN. @param {number} characters */
export function estimateTokens(characters) {
  return Number.isFinite(characters) && characters > 0 ? Math.ceil(characters / CHARS_PER_TOKEN) : 0;
}

/** Referencia para quien usa su propia cuenta de IA: lo que suele enviarse según los segundos de habla (≈ 13,3 caracteres por segundo, en pasos de 200). */
export const SUGGESTED_ESTIMATES = Object.freeze(
  [15, 30, 45, 60].map((seconds) => {
    const characters = Math.round((seconds * 40) / 3 / 200) * 200;
    return Object.freeze({ seconds, characters, tokens: estimateTokens(characters) });
  }),
);
