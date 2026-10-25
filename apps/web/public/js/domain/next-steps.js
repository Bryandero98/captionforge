// «¿Qué quieres hacer ahora?» (v1.3.1): las acciones que se ofrecen tras transcribir. Sin DOM.
// Cada paso lleva el id del elemento al que se lleva la vista. Un audio no tiene imagen: no se le ofrece poner subtítulos en el video.

import { canBurn } from "./media.js";

/**
 * @param {unknown} job el trabajo abierto (con `mediaKind` si el servidor lo informa)
 * @returns {{ id: "srt" | "translate" | "dub" | "video", target: string, available: boolean, reason?: "audio" }[]}
 */
export function nextSteps(job) {
  const burnable = canBurn(job);
  return [
    { id: "srt", target: "dl-srt", available: true },
    { id: "translate", target: "translate-form", available: true },
    { id: "dub", target: "dub-form", available: true },
    { id: "video", target: "burn-form", available: burnable, ...(burnable ? {} : { reason: /** @type {const} */ ("audio") }) },
  ];
}
