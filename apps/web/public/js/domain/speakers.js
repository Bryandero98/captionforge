// Quién habla (options.diarize): estado de la identificación, hablantes de una transcripción, color por hablante y el
// .srt con el nombre delante. Puro y sin DOM, para probarlo aparte. El .vtt usa segmentsToVtt (domain/subtitles.js).

import { formatTimestamp } from "./subtitles.js";

/** Cuántos colores distintos tiene la paleta (clases CSS `speaker-0` … `speaker-7`); con más hablantes se repiten. */
export const PALETTE_SIZE = 8;

/**
 * - "identified": se identificó a los hablantes.
 * - "fallback": se pidió, pero el worker no pudo y entregó la transcripción normal (hay que avisar).
 * - "none": no se pidió; no hay nada que mostrar.
 * @param {{ options?: unknown, result?: unknown } | null | undefined} job
 * @returns {"identified" | "fallback" | "none"}
 */
export function diarizationStatus(job) {
  const options = /** @type {{ diarize?: unknown } | null} */ (job?.options ?? null);
  const result = /** @type {{ diarized?: unknown } | null} */ (job?.result ?? null);
  if (result?.diarized === true) return "identified";
  if (options?.diarize === true) return "fallback";
  return "none";
}

/**
 * Color (0 … PALETTE_SIZE-1) del hablante que ocupa la posición `position` por orden de aparición.
 * @param {number} position
 */
export function speakerColor(position) {
  return ((position % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
}

/**
 * Los hablantes distintos, por orden de aparición.
 * @param {{ speaker?: string }[]} segments
 * @returns {{ id: string, color: number }[]}
 */
export function speakersOf(segments) {
  /** @type {string[]} */
  const ids = [];
  for (const segment of segments) {
    if (typeof segment.speaker === "string" && segment.speaker !== "" && !ids.includes(segment.speaker)) ids.push(segment.speaker);
  }
  return ids.map((id, position) => ({ id, color: speakerColor(position) }));
}

/**
 * El nombre que se ve: las etiquetas automáticas SPEAKER_nn se muestran como un nombre legible; las que puso la persona,
 * tal cual.
 * @param {string} label
 * @param {(n: number) => string} generic
 */
export function displayName(label, generic) {
  const match = /^SPEAKER_(\d{1,3})$/.exec(label);
  return match === null ? label : generic(Number(match[1]));
}

/**
 * El .srt del cliente, con «Nombre: » delante de cada subtítulo que tenga hablante.
 * @param {{ start: number, end: number, text: string, speaker?: string }[]} segments
 * @param {(segment: { speaker?: string }) => string | null} nameOf
 */
export function segmentsToSrtWithSpeakers(segments, nameOf) {
  const blocks = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\r\n?/g, "\n").replace(/\n[ \t]*(?=\n)/g, "\n").replace(/\n{2,}/g, "\n").trim();
    if (text === "") continue;
    const name = nameOf(segment);
    blocks.push(`${blocks.length + 1}\n${formatTimestamp(segment.start, ",")} --> ${formatTimestamp(segment.end, ",")}\n${name ? `${name}: ` : ""}${text}`);
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}
