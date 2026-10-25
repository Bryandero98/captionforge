// Plan de una subida (v1.3.0): decide, para un archivo, qué opciones se mandan al servidor y qué se encadena al terminar. Función pura.
//
//   manual      la persona tocó algún control de «Control total»: mandan esos controles, para todos los archivos
//   profile     eligió un perfil concreto en el selector: ese perfil para todos los archivos
//   auto        perfil sugerido por el análisis de cada archivo (el modo por defecto)

import { analyze } from "./intent.js";
import { PROFILES, followUpFor, optionsFor } from "./profiles.js";
import { followUpOf, themeById, unavailableReason } from "./themes.js";

const MODELS = ["base", "small", "medium"];
const LANGUAGE = /^[a-z]{2,3}$/;

/**
 * @typedef {{
 *   modelSize: string, sourceLanguage: string, translateTo: string, cleanAudio: boolean, diarize: boolean,
 *   autoBurn: boolean, burnTheme: string,
 * }} Controls
 * @typedef {{ profileChoice: string, manual: boolean, controls: Controls }} Choice
 * @typedef {{
 *   profileId: string | null, source: "auto" | "profile" | "manual",
 *   options: import("./profiles.js").UploadOptions, followUp: import("./profiles.js").FollowUp | null, notes: string[],
 * }} Plan
 */

/**
 * @param {{ facts: import("./profiles.js").MediaFacts | null }} entry el archivo y lo que se sabe de él (null: aún sin analizar)
 * @param {Choice} choice
 * @param {import("../api/capabilities.js").Capabilities} caps
 * @returns {Plan}
 */
export function planFor(entry, choice, caps) {
  const facts = entry?.facts ?? null;

  if (choice.manual) {
    const c = choice.controls;
    /** @type {string[]} */
    const notes = [];
    /** @type {import("./profiles.js").FollowUp | null} */
    let followUp = null;
    if (c.autoBurn && facts?.kind !== "audio") {
      const theme = themeById(c.burnTheme);
      // Sin duración conocida el servidor decide; con una conocida por encima del tope, o con una plantilla que no ofrece, no se promete.
      const unavailable = unavailableReason(theme, { durationSeconds: facts?.durationSeconds, caps });
      if (unavailable) notes.push(unavailable.code);
      else followUp = followUpOf(theme);
    }
    return {
      profileId: null,
      source: "manual",
      options: {
        modelSize: MODELS.includes(c.modelSize) ? c.modelSize : "small",
        sourceLanguage: LANGUAGE.test(c.sourceLanguage) ? c.sourceLanguage : "",
        translateTo: LANGUAGE.test(c.translateTo) ? c.translateTo : "",
        cleanAudio: c.cleanAudio === true,
        diarize: c.diarize === true && caps?.diarization?.enabled === true,
      },
      followUp,
      notes,
    };
  }

  const fixed = choice.profileChoice !== "auto";
  const profileId = fixed ? (Object.hasOwn(PROFILES, choice.profileChoice) ? choice.profileChoice : "standard") : facts ? analyze(facts, caps).profileId : "standard";
  const known_facts = facts ?? { kind: "video", durationSeconds: null, width: null, height: null };
  return {
    profileId,
    source: fixed ? "profile" : "auto",
    options: optionsFor(profileId, caps, known_facts),
    followUp: followUpFor(profileId, known_facts, caps),
    notes: [],
  };
}
