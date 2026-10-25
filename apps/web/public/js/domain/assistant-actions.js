// Acciones que propone el asistente (ADR 0028): se validan otra vez aquí (el servidor ya las sanea, pero la página no se fía) y se traducen a
// operaciones sobre los botones y campos que la persona ya tiene. Sin DOM: quien ejecuta las operaciones es ui/assistant.js, y solo después
// de que la persona pulse «Aplicar». Todo lo que cuesta pasa además por la confirmación de gasto de la propia página.

/** @typedef {{ type: "click", id: string } | { type: "select", id: string, value: string } | { type: "text", id: string, value: string }} Op */
/** @typedef {{ name: string, args: Record<string, unknown> }} ProposedAction */
/** @typedef {{ ok: true, name: string, spend: boolean, ops: Op[] } | { ok: false, reason?: string }} Plan */

const STEPS = ["srt", "translate", "dub", "video"];
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const VOICE = /^[A-Za-z0-9 ._:@-]{1,64}$/;
const FAIL = Object.freeze({ ok: false });

/** @param {unknown} value @param {readonly string[]} allowed */
const oneOf = (value, allowed) => (typeof value === "string" && allowed.includes(value) ? value : undefined);

/**
 * @param {ProposedAction | null | undefined} action
 * @param {{ audio?: boolean }} [context]
 * @returns {Plan}
 */
export function planAction(action, { audio = false } = {}) {
  if (action === null || typeof action !== "object" || typeof action.name !== "string") return FAIL;
  const args = action.args !== null && typeof action.args === "object" ? action.args : {};
  switch (action.name) {
    case "go_to_step": {
      const step = oneOf(args.step, STEPS);
      return step === undefined ? FAIL : { ok: true, name: "go_to_step", spend: false, ops: [{ type: "click", id: `next-${step}` }] };
    }
    case "translate": {
      if (typeof args.targetLanguage !== "string" || !LANGUAGE.test(args.targetLanguage)) return FAIL;
      const provider = args.provider === undefined ? "argos" : oneOf(args.provider, ["argos", "openai"]);
      if (provider === undefined) return FAIL;
      return {
        ok: true,
        name: "translate",
        spend: provider !== "argos",
        ops: [
          { type: "select", id: "translate-provider", value: provider },
          { type: "select", id: "translate-target", value: args.targetLanguage },
          { type: "click", id: "translate-start" },
        ],
      };
    }
    case "dub": {
      /** @type {Op[]} */
      const ops = [];
      if (args.provider !== undefined) {
        const provider = oneOf(args.provider, ["openai", "elevenlabs"]);
        if (provider === undefined) return FAIL;
        ops.push({ type: "select", id: "dub-provider", value: provider });
      }
      if (args.voice !== undefined) {
        if (typeof args.voice !== "string" || !VOICE.test(args.voice)) return FAIL;
        ops.push({ type: "text", id: "dub-voice", value: args.voice });
      }
      if (args.mix !== undefined) {
        const mix = oneOf(args.mix, ["none", "replace", "duck"]);
        if (mix === undefined) return FAIL;
        ops.push({ type: "select", id: "dub-mix", value: mix });
      }
      return { ok: true, name: "dub", spend: true, ops: [...ops, { type: "click", id: "dub-start" }] };
    }
    case "burn":
      return audio ? { ok: false, reason: "audio" } : { ok: true, name: "burn", spend: false, ops: [{ type: "click", id: "burn-start" }] };
    case "download_srt":
      return { ok: true, name: "download_srt", spend: false, ops: [{ type: "click", id: "dl-srt" }] };
    default:
      return FAIL;
  }
}
