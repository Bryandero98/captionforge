// Análisis de intención (v1.3.0, iniciativa 1): de lo que el navegador ya sabe de un archivo (clase, duración, dimensiones) a un perfil
// sugerido y sus motivos. Función pura: sin DOM, sin red, sin estado. La tabla de reglas es ordenada y la primera que casa gana; siempre hay un
// perfil de respaldo («standard») que equivale a los valores de hoy. Jamás infiere idioma ni traducción.
//
// Los motivos son objetos { code, ...enteros }: la interfaz los traduce (`intent.<code>`). Los códigos son un conjunto cerrado.

/** Umbrales de las reglas, en un solo sitio. */
export const THRESHOLDS = Object.freeze({
  /** Un audio de al menos 5 min es un podcast o una entrevista. */
  podcastMinSeconds: 300,
  /** Un video horizontal de al menos 20 min es una reunión o una clase. */
  meetingMinSeconds: 1200,
  /** Un video horizontal de menos de 3 min es un clip rápido. */
  quickClipMaxSeconds: 180,
  /** Identificar hablantes es lento en CPU: solo por debajo de 60 min. */
  diarizeMaxSeconds: 3600,
});

const DEFAULT_VERTICAL_MAX = 600;

/** @typedef {import("./profiles.js").MediaFacts} MediaFacts */
/** @typedef {import("./profiles.js").ProfileId} ProfileId */
/** @typedef {{ code: string, [param: string]: string | number }} Reason */

/** @param {unknown} value @returns {value is number} */
const known = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const minutes = (/** @type {number} */ seconds) => Math.round(seconds / 60);

/**
 * @param {Partial<MediaFacts> | undefined} facts
 * @param {Partial<import("../api/capabilities.js").Capabilities> | undefined} caps
 * @returns {{ profileId: ProfileId, reasons: Reason[] }}
 */
export function analyze(facts, caps) {
  const kind = facts?.kind === "audio" ? "audio" : "video";
  const duration = facts?.durationSeconds;
  if (!known(duration)) return { profileId: "standard", reasons: [{ code: "duration_unknown" }] };

  const verticalMax = known(caps?.limits?.verticalMaxSeconds) ? caps.limits.verticalMaxSeconds : DEFAULT_VERTICAL_MAX;

  if (kind === "audio") {
    return duration >= THRESHOLDS.podcastMinSeconds
      ? { profileId: "podcast", reasons: [{ code: "audio_long", minutes: minutes(duration) }] }
      : { profileId: "standard", reasons: [{ code: "audio_short", seconds: Math.round(duration) }] };
  }

  // Misma definición de 9:16 que el worker: ancho×16 ≤ alto×9.
  const portrait = known(facts?.width) && known(facts?.height) && facts.width * 16 <= facts.height * 9;
  if (portrait) {
    return duration <= verticalMax
      ? { profileId: "vertical", reasons: [{ code: "portrait_short", seconds: Math.round(duration) }] }
      : { profileId: "standard", reasons: [{ code: "portrait_too_long", minutes: minutes(duration), maxMinutes: minutes(verticalMax) }] };
  }
  if (duration >= THRESHOLDS.meetingMinSeconds) return { profileId: "meeting", reasons: [{ code: "meeting_long", minutes: minutes(duration) }] };
  if (duration < THRESHOLDS.quickClipMaxSeconds) return { profileId: "quick-clip", reasons: [{ code: "clip_short", seconds: Math.round(duration) }] };
  return { profileId: "standard", reasons: [{ code: "video_medium", minutes: minutes(duration) }] };
}

/** Un resultado por archivo, en el mismo orden (los lotes se analizan archivo a archivo). @param {readonly Partial<MediaFacts>[]} list @param {Parameters<typeof analyze>[1]} caps */
export const analyzeAll = (list, caps) => list.map((facts) => analyze(facts, caps));
