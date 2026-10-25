// Modo Rápido (v1.3.0): el botón «Generar subtítulos» sirve solo con lo que el navegador sabe del archivo. Este módulo mantiene coherentes
// tres cosas: el resumen vivo (región aria-live), el perfil sugerido con su motivo, y los controles de «Control total» (<details id="advanced">).
//
//   automático   perfil sugerido por archivo; los controles de «Control total» solo reflejan lo que se va a hacer
//   perfil       la persona eligió un perfil en el selector: vale para todos los archivos
//   manual       la persona tocó un control: mandan los controles (y se guardan como preferencias de este navegador)
//
// Sincronizar los controles desde el código no dispara `change`, así que solo los gestos de la persona pasan a manual.

import { BURN_TEMPLATES } from "../domain/burn-options.js";
import { analyze } from "../domain/intent.js";
import { clearPrefs, defaultPrefs, hasStoredPrefs, loadPrefs, savePrefs } from "../domain/prefs.js";
import { planFor } from "../domain/plan.js";
import { PROFILE_IDS } from "../domain/profiles.js";

const CONTROL_IDS = /** @type {const} */ (["opt-model", "opt-source", "opt-translate", "opt-clean", "opt-diarize", "opt-autoburn", "opt-burn-format", "opt-burn-template"]);

/**
 * @param {{
 *   doc: { getElementById: (id: string) => any, createElement: (tag: string) => any },
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   storage: Storage | null | undefined,
 *   getCaps: () => import("../api/capabilities.js").Capabilities,
 *   probe: (file: any, kind: string) => Promise<import("../domain/profiles.js").MediaFacts>,
 *   announce: (text: string) => void,
 *   pending: () => number,
 *   languageName?: (code: string) => string,
 * }} deps
 */
export function createQuickMode({ doc, t, storage, getCaps, probe, announce, pending, languageName = (code) => code.toUpperCase() }) {
  /** @param {string} id */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    advanced: $("advanced"),
    profile: $("opt-profile"),
    model: $("opt-model"),
    source: $("opt-source"),
    translate: $("opt-translate"),
    clean: $("opt-clean"),
    diarize: $("opt-diarize"),
    autoBurn: $("opt-autoburn"),
    burnFormat: $("opt-burn-format"),
    burnTemplate: $("opt-burn-template"),
    reset: $("advanced-reset"),
    summary: $("quick-summary"),
    suggestion: $("quick-suggestion"),
    suggestionText: $("quick-suggestion-text"),
    suggestionChange: $("quick-suggestion-change"),
    suggestionDismiss: $("quick-suggestion-dismiss"),
    warning: $("quick-warning"),
  };

  /** @type {Map<string | number, { facts: import("../domain/profiles.js").MediaFacts | null, done: boolean }>} */
  const entries = new Map();
  /** @type {Set<Promise<unknown>>} */
  const probing = new Set();
  let profileChoice = "auto";
  let manual = false;
  let lastSummary = "";
  let lastSummaryShown = false;
  let labelsFor = "";
  /** Lo guardado: «hablantes» se conserva aunque el servidor no lo ofrezca ahora (la casilla queda apagada). */
  let stored = loadPrefs(storage);

  const caps = () => getCaps();

  // «Control total» se cierra al iniciar: sin JavaScript el HTML lo deja abierto y todo sigue siendo usable.
  els.advanced.open = false;
  buildStaticOptions();
  if (hasStoredPrefs(storage)) {
    applyControls({
      modelSize: stored.modelSize, sourceLanguage: stored.sourceLanguage, translateTo: stored.translateTo, cleanAudio: stored.cleanAudio, diarize: stored.diarize,
      autoBurn: stored.autoBurn, burnFormat: stored.burnFormat, burnTemplate: stored.burnTemplate,
    });
    manual = true;
  }

  function buildStaticOptions() {
    els.burnFormat.replaceChildren(...["classic", "vertical"].map((value) => option(value, t(`burn.format.${value}`))));
    els.burnTemplate.replaceChildren(...BURN_TEMPLATES.map((value) => option(value, t(`burn.template.${value}`))));
  }

  /** @param {string} value @param {string} label */
  function option(value, label) {
    const element = doc.createElement("option");
    element.value = value;
    element.textContent = label;
    return element;
  }

  /** Los nombres de perfil y de formato dependen del idioma: se reconstruyen solo cuando cambian. */
  function relabel() {
    const signature = [t("profile.auto"), ...PROFILE_IDS.map((id) => t(`profile.${id}`)), t("burn.format.classic")].join("|");
    if (signature === labelsFor) return;
    labelsFor = signature;
    els.profile.replaceChildren(option("auto", t("profile.auto")), ...PROFILE_IDS.map((id) => option(id, t(`profile.${id}`))));
    els.profile.value = profileChoice;
    const format = els.burnFormat.value;
    const template = els.burnTemplate.value;
    buildStaticOptions();
    els.burnFormat.value = format || "classic";
    els.burnTemplate.value = template || BURN_TEMPLATES[0];
  }

  function readControls() {
    return {
      modelSize: els.model.value,
      sourceLanguage: els.source.value,
      translateTo: els.translate.value,
      cleanAudio: els.clean.checked === true,
      diarize: els.diarize.checked === true,
      autoBurn: els.autoBurn.checked === true,
      burnFormat: /** @type {"vertical" | "classic"} */ (els.burnFormat.value === "vertical" ? "vertical" : "classic"),
      burnTemplate: els.burnTemplate.value || BURN_TEMPLATES[0],
    };
  }

  /** @param {ReturnType<typeof readControls>} c */
  function applyControls(c) {
    els.model.value = c.modelSize;
    els.source.value = c.sourceLanguage;
    els.translate.value = c.translateTo;
    els.clean.checked = c.cleanAudio;
    els.diarize.checked = c.diarize && els.diarize.disabled !== true;
    els.autoBurn.checked = c.autoBurn;
    els.burnFormat.value = c.burnFormat;
    els.burnTemplate.value = c.burnTemplate;
  }

  const choice = () => ({ profileChoice, manual, controls: readControls() });

  /** @param {string | number} key */
  function planOf(key) {
    return planFor(entries.get(key) ?? { facts: null }, choice(), caps());
  }

  /** Plan del primer archivo (o el de un archivo desconocido): es lo que reflejan los controles. */
  function firstPlan() {
    const [first] = shownKeys();
    return planOf(first ?? "");
  }

  /** Los archivos que aún faltan por subir; si ya no falta ninguno, todos (el resumen sigue describiendo lo que se hizo). */
  function shownKeys() {
    const waiting = [...entries].filter(([, entry]) => !entry.done).map(([key]) => key);
    return waiting.length > 0 ? waiting : [...entries.keys()];
  }

  function syncControlsFromPlan() {
    if (manual) return;
    const plan = firstPlan();
    const burn = plan.followUp?.burn;
    applyControls({
      ...plan.options,
      autoBurn: burn !== undefined,
      burnFormat: burn?.canvas === "vertical" ? "vertical" : "classic",
      burnTemplate: burn?.template ?? readControls().burnTemplate,
    });
  }

  /** Nombre legible de un perfil. @param {string} id */
  const profileName = (id) => t(`profile.${id}`);

  function summaryText() {
    const c = readControls();
    const parts = [];
    const plans = shownKeys().map(planOf);
    if (manual) parts.push(t("quick.sum.manual"));
    else if (plans.length > 1) {
      const counts = new Map();
      for (const plan of plans) counts.set(plan.profileId, (counts.get(plan.profileId) ?? 0) + 1);
      const list = [...counts].map(([id, n]) => `${n}× ${profileName(id)}`).join(", ");
      parts.push(t("quick.sum.batch", { count: plans.length, list }));
    } else parts.push(t("quick.sum.profile", { profile: profileName(firstPlan().profileId ?? "standard") }));

    const plan = firstPlan();
    parts.push(t("quick.sum.model", { model: t(`options.model.${plan.options.modelSize}`) }));
    parts.push(t("quick.sum.language", { language: plan.options.sourceLanguage === "" ? t("options.source.auto") : languageName(plan.options.sourceLanguage) }));
    if (plan.options.translateTo !== "") parts.push(t("quick.sum.translate", { language: languageName(plan.options.translateTo) }));
    if (plan.options.cleanAudio) parts.push(t("quick.sum.clean"));
    if (plan.options.diarize) parts.push(t("quick.sum.speakers"));
    const burn = plan.followUp?.burn;
    if (burn) parts.push(burn.canvas === "vertical" ? t("quick.sum.after.vertical") : t("quick.sum.after.classic"));
    else if (manual && c.autoBurn && plan.notes.includes("vertical_too_long")) parts.push(t("quick.sum.vertical.toolong"));
    return parts.join(" · ");
  }

  /** Primer archivo con un perfil sugerido distinto de Estándar (solo en automático). */
  function suggestion() {
    if (manual || profileChoice !== "auto") return null;
    for (const key of shownKeys()) {
      const entry = entries.get(key);
      if (!entry || entry.facts === null) continue;
      const result = analyze(entry.facts, caps());
      if (result.profileId !== "standard") {
        const reason = result.reasons[0];
        const { code = "", ...params } = reason ?? {};
        return { profileId: result.profileId, reason: reason ? t(`intent.${code}`, params) : "" };
      }
    }
    return null;
  }

  function refresh() {
    relabel();
    els.profile.value = profileChoice;
    syncControlsFromPlan();
    els.burnFormat.disabled = !els.autoBurn.checked;
    els.burnTemplate.disabled = !els.autoBurn.checked || els.burnFormat.value !== "vertical";

    const text = summaryText();
    if (text !== lastSummary) {
      lastSummary = text;
      const first = lastSummaryShown === false;
      lastSummaryShown = true;
      els.summary.textContent = text;
      if (!first) announce(text); // el texto inicial no se lee solo al cargar la página
    }

    const hint = suggestion();
    els.suggestion.hidden = hint === null;
    if (hint !== null) els.suggestionText.textContent = t("quick.suggest", { profile: profileName(hint.profileId), reason: hint.reason });

    const waiting = [...entries].filter(([, entry]) => !entry.done).map(([key]) => key);
    const chains = waiting.some((key) => planOf(key).followUp !== null) || (entries.size === 0 && firstPlan().followUp !== null);
    els.warning.hidden = !(chains || pending() > 0);
  }

  function persist() {
    const c = readControls();
    stored = { ...defaultPrefs(), ...stored, autoProfile: profileChoice === "auto", modelSize: /** @type {any} */ (c.modelSize), sourceLanguage: c.sourceLanguage, translateTo: c.translateTo, cleanAudio: c.cleanAudio, diarize: els.diarize.disabled === true ? stored.diarize : c.diarize, autoBurn: c.autoBurn, burnFormat: c.burnFormat, burnTemplate: c.burnTemplate };
    savePrefs(storage, stored);
  }

  /** Un gesto de la persona sobre un control: manda lo que ve, para todos los archivos. */
  function onControlChange() {
    manual = true;
    persist();
    refresh();
  }
  for (const id of CONTROL_IDS) $(id).addEventListener("change", onControlChange);

  els.profile.addEventListener("change", () => {
    profileChoice = els.profile.value || "auto";
    manual = false;
    refresh();
  });
  els.suggestionDismiss.addEventListener("click", () => {
    profileChoice = "standard";
    manual = false;
    refresh();
  });
  els.suggestionChange.addEventListener("click", () => {
    els.advanced.open = true;
    els.profile.focus();
  });
  els.reset.addEventListener("click", () => {
    clearPrefs(storage);
    stored = loadPrefs(null);
    manual = false;
    profileChoice = "auto";
    const defaults = defaultPrefs();
    applyControls({ modelSize: defaults.modelSize, sourceLanguage: "", translateTo: "", cleanAudio: false, diarize: false, autoBurn: false, burnFormat: defaults.burnFormat, burnTemplate: defaults.burnTemplate });
    refresh();
  });

  refresh();

  return {
    /** Analiza los archivos nuevos de la cola y olvida los que ya no están. @param {{ key: string | number, file: any, kind: string, done?: boolean }[]} items */
    track(items) {
      const keys = new Set(items.map((item) => item.key));
      for (const key of [...entries.keys()]) if (!keys.has(key)) entries.delete(key);
      for (const item of items) {
        const known = entries.get(item.key);
        if (known) {
          known.done = item.done === true;
          continue;
        }
        const entry = { facts: /** @type {import("../domain/profiles.js").MediaFacts | null} */ (null), done: item.done === true };
        entries.set(item.key, entry);
        const job = probe(item.file, item.kind)
          .then((facts) => {
            if (entries.get(item.key) === entry) entry.facts = facts;
          })
          .catch((error) => console.error(error)) // sin lectura el archivo sigue el plan de siempre
          .finally(() => {
            probing.delete(job);
            refresh();
          });
        probing.add(job);
      }
      refresh();
    },
    /** @param {string | number} key */
    plan: planOf,
    /** Espera a que termine la lectura de los archivos en curso (cada una tiene su propio tiempo máximo). */
    settled: async () => {
      while (probing.size > 0) await Promise.all([...probing]);
    },
    refresh,
    reset() {
      entries.clear();
      profileChoice = manual ? profileChoice : "auto";
      refresh();
    },
  };
}
