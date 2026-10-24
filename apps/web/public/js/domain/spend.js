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
