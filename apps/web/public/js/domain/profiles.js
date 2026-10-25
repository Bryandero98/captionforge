// Perfiles de uso (v1.3.0, iniciativa 1). Un perfil NO es un concepto del servidor: es una tabla del cliente que se traduce a las opciones
// explícitas de siempre (modelo, hablantes…) y, si procede, a las del quemado. El contrato de la API no cambia y la intención de la
// persona nunca viaja ni se guarda.
//
// Reglas de seguridad de los perfiles: jamás activan solos el idioma de origen, la traducción ni la limpieza de voz (cambian el resultado
// o cuestan tiempo), y lo único que encadenan es el quemado de subtítulos, que es local y barato.

import { BURN_TEMPLATES } from "./burn-options.js";
import { THRESHOLDS } from "./intent.js";

/** Identificadores estables (también claves de traducción `profile.<id>`). */
export const PROFILE_IDS = /** @type {const} */ (["vertical", "podcast", "meeting", "quick-clip", "standard"]);

/** @typedef {typeof PROFILE_IDS[number]} ProfileId */
/** @typedef {{ kind: "audio" | "video", durationSeconds: number | null, width: number | null, height: number | null }} MediaFacts */
/** @typedef {{ modelSize: string, sourceLanguage: string, translateTo: string, cleanAudio: boolean, diarize: boolean }} UploadOptions */
/** @typedef {{ burn: { canvas: "source" | "vertical", template?: string, style?: string } }} FollowUp */
/** @typedef {import("../api/capabilities.js").Capabilities} Capabilities */

/**
 * @type {Readonly<Record<ProfileId, Readonly<{ id: ProfileId, modelSize: string, wantsSpeakers: boolean }>>>}
 */
export const PROFILES = Object.freeze({
  vertical: Object.freeze({ id: "vertical", modelSize: "small", wantsSpeakers: false }),
  podcast: Object.freeze({ id: "podcast", modelSize: "small", wantsSpeakers: true }),
  meeting: Object.freeze({ id: "meeting", modelSize: "small", wantsSpeakers: true }),
  "quick-clip": Object.freeze({ id: "quick-clip", modelSize: "small", wantsSpeakers: false }),
  standard: Object.freeze({ id: "standard", modelSize: "small", wantsSpeakers: false }),
});

/** @param {unknown} id @returns {Readonly<{ id: ProfileId, modelSize: string, wantsSpeakers: boolean }>} un id desconocido es Estándar */
const profileOf = (id) => (typeof id === "string" && Object.hasOwn(PROFILES, id) ? PROFILES[/** @type {ProfileId} */ (id)] : PROFILES.standard);

/** @param {unknown} value @returns {value is number} */
const known = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Opciones de la subida (`options` de POST /v1/jobs/transcribe) para un perfil. Idioma y traducción siempre quedan en «automático» y «ninguna».
 * Los hablantes solo se piden si el perfil los quiere, el servidor los ofrece y la duración, conocida, es menor de 60 min.
 * @param {string} id @param {Capabilities} caps @param {Partial<MediaFacts>} facts
 * @returns {UploadOptions}
 */
export function optionsFor(id, caps, facts) {
  const profile = profileOf(id);
  const duration = facts?.durationSeconds;
  const diarize = profile.wantsSpeakers && caps?.diarization?.enabled === true && known(duration) && duration < THRESHOLDS.diarizeMaxSeconds;
  return { modelSize: profile.modelSize, sourceLanguage: "", translateTo: "", cleanAudio: false, diarize };
}

/**
 * Qué se encadena al terminar la transcripción (siempre solo el quemado), o null.
 * @param {string} id @param {Partial<MediaFacts>} facts @param {Capabilities} caps
 * @returns {FollowUp | null}
 */
export function followUpFor(id, facts, caps) {
  const profile = profileOf(id);
  if (profile.id === "quick-clip") return { burn: { canvas: "source", style: "modern" } };
  if (profile.id !== "vertical") return null;
  const duration = facts?.durationSeconds;
  const max = caps?.limits?.verticalMaxSeconds;
  if (!known(duration) || !known(max) || duration > max) return null; // sin duración conocida no se promete lo que el servidor podría rechazar
  const offered = Array.isArray(caps?.burn?.templates) ? caps.burn.templates : BURN_TEMPLATES;
  const template = BURN_TEMPLATES.find((name) => offered.includes(name)) ?? BURN_TEMPLATES[0];
  return { burn: { canvas: "vertical", template } };
}
