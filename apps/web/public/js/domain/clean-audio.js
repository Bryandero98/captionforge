// Qué decir de la limpieza de audio (cleanAudio) de un trabajo terminado. Puro y sin DOM, para probarlo aparte.

/**
 * - "cleaned": la voz se aisló antes de transcribir.
 * - "fallback": se pidió, pero el worker no pudo y transcribió el audio original (hay que avisar).
 * - "none": no se pidió; no hay nada que mostrar.
 * @param {{ options?: unknown, result?: unknown } | null | undefined} job
 * @returns {"cleaned" | "fallback" | "none"}
 */
export function cleanAudioStatus(job) {
  const options = /** @type {{ cleanAudio?: unknown } | null} */ (job?.options ?? null);
  const result = /** @type {{ audioCleaned?: unknown } | null} */ (job?.result ?? null);
  if (result?.audioCleaned === true) return "cleaned";
  if (options?.cleanAudio === true) return "fallback";
  return "none";
}
