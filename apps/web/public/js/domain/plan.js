// Plan de una subida (v1.3.0): decide, para un archivo, qué opciones se mandan al servidor y qué se encadena al terminar. Función pura.
//
//   manual      la persona tocó algún control de «Control total»: mandan esos controles, para todos los archivos
//   profile     eligió un perfil concreto en el selector: ese perfil para todos los archivos
//   auto        perfil sugerido por el análisis de cada archivo (el modo por defecto)

import { BURN_TEMPLATES } from "./burn-options.js";
import { analyze } from "./intent.js";
import { PROFILES, followUpFor, optionsFor } from "./profiles.js";

const MODELS = ["base", "small", "medium"];
const LANGUAGE = /^[a-z]{2,3}$/;

/**
 * @typedef {{
 *   modelSize: string, sourceLanguage: string, translateTo: string, cleanAudio: boolean, diarize: boolean,
 *   autoBurn: boolean, burnFormat: string, burnTemplate: string,
 * }} Controls
 * @typedef {{ profileChoice: string, manual: boolean, controls: Controls }} Choice
 * @typedef {{
 *   profileId: string | null, source: "auto" | "profile" | "manual",
 *   options: import("./profiles.js").UploadOptions, followUp: import("./profiles.js").FollowUp | null, notes: string[],
 * }} Plan
 */

/** @param {unknown} value @returns {value is number} */
const known = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

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
      if (c.burnFormat === "vertical") {
        const max = caps?.limits?.verticalMaxSeconds;
        if (known(facts?.durationSeconds) && known(max) && facts.durationSeconds > max) notes.push("vertical_too_long");
        else {
          const offered = Array.isArray(caps?.burn?.templates) ? caps.burn.templates : BURN_TEMPLATES;
          const template = BURN_TEMPLATES.includes(/** @type {any} */ (c.burnTemplate)) && offered.includes(c.burnTemplate) ? c.burnTemplate : (BURN_TEMPLATES.find((name) => offered.includes(name)) ?? BURN_TEMPLATES[0]);
          followUp = { burn: { canvas: "vertical", template } };
        }
      } else {
        followUp = { burn: { canvas: "source", style: "modern" } };
      }
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
