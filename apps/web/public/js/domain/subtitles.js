// Utilidades de subtítulos del lado del cliente: marcas de tiempo y conversión a WebVTT. El .srt lo genera el servidor
// (es el artefacto «srt»); el .vtt se arma aquí a partir de los segmentos, así el API no necesita otro formato.

/**
 * `HH:MM:SS<sep>mmm`. Un valor no finito o negativo se trata como 0.
 * @param {number} seconds
 * @param {"." | ","} separator
 */
export function formatTimestamp(seconds, separator) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const two = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(ms).padStart(3, "0")}`;
}

/** WebVTT interpreta &, < y > en el texto de un bloque, y una línea en blanco o «-->» lo rompen. */
function cueText(/** @type {string} */ text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]*(?=\n)/g, "\n") // una linea de solo espacios tambien separa bloques en algunos lectores
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * @param {{ start: number, end: number, text: string }[]} segments
 * @returns {string}
 */
export function segmentsToVtt(segments) {
  const blocks = [];
  for (const segment of segments) {
    const text = cueText(segment.text);
    if (text === "") continue;
    blocks.push(`${blocks.length + 1}\n${formatTimestamp(segment.start, ".")} --> ${formatTimestamp(segment.end, ".")}\n${text}`);
  }
  return blocks.length === 0 ? "WEBVTT\n" : `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Lo contrario de formatTimestamp: «SS», «MM:SS» o «HH:MM:SS», con decimales opcionales (punto o coma).
 * Devuelve segundos, o null si el texto no es una marca de tiempo válida.
 * @param {string} text
 * @returns {number | null}
 */
export function parseTimestamp(text) {
  const match = /^\s*(?:(?:(\d{1,3}):)?(\d{1,2}):)?(\d{1,6})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (match === null) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const hasHours = hours !== undefined;
  if (hasHours && Number(minutes) > 59) return null;
  if ((hasHours || minutes !== undefined) && Number(seconds) > 59) return null;
  const total = Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds) + (fraction === undefined ? 0 : Number(fraction.padEnd(3, "0")) / 1000);
  return Number.isFinite(total) ? total : null;
}
