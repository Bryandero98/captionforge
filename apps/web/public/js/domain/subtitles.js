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
