// Calidad de los subtítulos (ADR 0021), dentro de la vista de resultados.
// Reglas de esta pantalla:
//  - El verificador vive en el API: aquí solo se pide el informe y se pinta. Ninguna regla (CPS, CPL, solapes…) se calcula en el navegador.
//  - «Proponer arreglo» solo muestra qué cambiaría (tiempos de final y saltos de línea, nunca el texto); nada se guarda hasta «Aplicar».
//  - Aplicar usa el flujo de edición normal (PUT /segments con el mismo etag): si alguien editó entre tanto, el API responde 409 y se pide revisar de nuevo.
//  - La gravedad se dice con palabras, no solo con color. Los errores salen por su código estable, traducidos; nunca el texto del servidor.
//  - Todo texto entra con textContent.

import { ApiError } from "../api/errors.js";

/** Cuántas incidencias se pintan; el resto se cuenta. */
const MAX_ISSUES = 50;
const MAX_CHANGES = 20;
const SPANISH_DEFAULT = "netflix-es";
const GENERIC_DEFAULT = "netflix";

/**
 * @param {{
 *   doc: Document, t: (key: string, params?: Record<string, string | number>) => string,
 *   lang: () => string, announce: (text: string) => void,
 *   context: () => { job: { id: string }, dirty: boolean, language: string | null } | null,
 *   canEdit: boolean,
 *   fetchProfiles: () => Promise<import("../api/jobs.js").QualityProfile[]>,
 *   fetchReport: (args: { jobId: string, profile: string }) => Promise<import("../api/jobs.js").QualityReport>,
 *   fetchFix: (args: { jobId: string, profile: string }) => Promise<import("../api/jobs.js").QualityFix>,
 *   applyEdits: (args: { jobId: string, edits: import("../api/jobs.js").QualityFix["edits"], etag: string }) => Promise<unknown>,
 *   onApplied: () => void | Promise<void>,
 * }} deps `t` es el traductor inicial; `refresh(next)` lo cambia
 */
export function createQuality({ doc, t: initialT, lang, announce, context, canEdit, fetchProfiles, fetchReport, fetchFix, applyEdits, onApplied }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    panel: $("quality-panel"), profile: $("quality-profile"), profileNote: $("quality-profile-note"), check: $("quality-check"), fix: $("quality-fix"),
    hint: $("quality-hint"), status: $("quality-status"), summary: $("quality-summary"), issues: $("quality-issues"), proposal: $("quality-proposal"),
    proposalSummary: $("quality-proposal-summary"), changes: $("quality-proposal-changes"), unfixable: $("quality-proposal-unfixable"),
    apply: $("quality-apply"), discard: $("quality-discard"),
  };

  let t = initialT;
  /** @type {import("../api/jobs.js").QualityProfile[]} */
  let profiles = [];
  let profilesRequested = false;
  let profilesFailed = false;
  /** @type {string | null} */
  let currentJob = null;
  /** @type {import("../api/jobs.js").QualityReport | null} */
  let report = null;
  /** @type {import("../api/jobs.js").QualityFix | null} */
  let proposal = null;
  let busy = false;
  /** Sube al cambiar de transcripción: lo que vuelva de una petición vieja se descarta. */
  let epoch = 0;
  /** @type {string | null} */
  let statusKey = null;

  const number = (/** @type {number} */ value, max = 1) => new Intl.NumberFormat(lang(), { maximumFractionDigits: max }).format(value);

  /** @param {unknown} error */
  function describe(error) {
    const code = error instanceof ApiError ? error.code : "network";
    return t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
  }

  /** @param {string} text */
  function setStatus(text) {
    els.status.textContent = text;
  }

  function reset() {
    epoch += 1;
    report = null;
    proposal = null;
    busy = false;
    statusKey = null;
    setStatus("");
    els.summary.textContent = "";
    els.issues.replaceChildren();
  }

  const profileName = (/** @type {import("../api/jobs.js").QualityProfile} */ profile) => {
    const key = `quality.profileName.${profile.id}`;
    const translated = t(key);
    return translated === key ? profile.label : translated;
  };

  function renderProfiles() {
    const keep = els.profile.value;
    els.profile.replaceChildren(...profiles.map((profile) => Object.assign(doc.createElement("option"), { value: profile.id, textContent: profileName(profile) })));
    const has = (/** @type {string} */ id) => profiles.some((profile) => profile.id === id);
    const ctx = context();
    const preferred = ctx?.language === "es" ? SPANISH_DEFAULT : GENERIC_DEFAULT;
    els.profile.value = has(keep) ? keep : has(preferred) ? preferred : (profiles[0]?.id ?? "");
    renderProfileNote();
  }

  function renderProfileNote() {
    const selected = profiles.find((profile) => profile.id === els.profile.value);
    els.profileNote.textContent = selected === undefined ? "" : t(`quality.verification.${selected.verification}`);
  }

  /** @param {import("../api/jobs.js").QualityIssue} item */
  function issueMessage(item) {
    return t(`quality.rule.${item.rule}`, {
      measured: number(item.measured, 2),
      limit: number(item.limit, 2),
      line: item.line ?? 1,
      percent: Math.round(item.measured * 100),
    });
  }

  function renderReport() {
    els.issues.replaceChildren();
    if (report === null) {
      els.summary.textContent = "";
      return;
    }
    const { summary, issues } = report;
    els.summary.textContent = summary.errors + summary.warnings + summary.infos === 0 ? t("quality.clean", { score: summary.score }) : t("quality.summary", { score: summary.score, errors: summary.errors, warnings: summary.warnings, infos: summary.infos });
    const rows = issues.slice(0, MAX_ISSUES).map((item) => {
      const row = doc.createElement("li");
      row.className = `quality__issue quality__issue--${item.severity}`;
      const severity = doc.createElement("strong");
      severity.className = "quality__severity";
      severity.textContent = t(`quality.severity.${item.severity}`);
      const text = doc.createElement("span");
      text.textContent = ` ${t("quality.issue", { n: item.segment + 1, message: issueMessage(item) })}`;
      row.append(severity, text);
      return row;
    });
    if (issues.length > MAX_ISSUES) {
      const more = doc.createElement("li");
      more.className = "quality__more";
      more.textContent = t("quality.more", { count: issues.length - MAX_ISSUES });
      rows.push(more);
    }
    els.issues.replaceChildren(...rows);
  }

  function renderProposal() {
    els.proposal.hidden = proposal === null;
    if (proposal === null) return;
    const { edits, changes, unfixable, before, after } = proposal;
    els.changes.replaceChildren();
    if (edits.length === 0) {
      els.proposalSummary.textContent = t("quality.proposal.none");
      els.apply.hidden = true;
    } else {
      els.proposalSummary.textContent = t("quality.proposal.summary", {
        count: edits.length, errorsBefore: before.errors, errorsAfter: after.errors, warningsBefore: before.warnings, warningsAfter: after.warnings,
      });
      els.apply.hidden = false;
      els.changes.replaceChildren(
        ...changes.slice(0, MAX_CHANGES).map((change) => {
          const row = doc.createElement("li");
          row.textContent =
            change.kind === "line_break"
              ? t("quality.change.line_break", { n: change.segment + 1 })
              : t("quality.change.timing", { n: change.segment + 1, from: number(change.before.end, 2), to: number(change.after.end, 2) });
          return row;
        }),
      );
    }
    els.unfixable.hidden = unfixable.length === 0;
    els.unfixable.textContent = unfixable.length === 0 ? "" : t("quality.unfixable", { count: unfixable.length });
    els.apply.disabled = busy;
    els.discard.disabled = busy;
  }

  function render() {
    const ctx = context();
    els.panel.hidden = ctx === null;
    if (ctx === null) return;
    const dirty = ctx.dirty;
    els.hint.hidden = !dirty;
    els.hint.textContent = dirty ? t("quality.dirty") : "";
    els.check.disabled = dirty || busy || profiles.length === 0;
    els.profile.disabled = busy || profiles.length === 0;
    const worth = report !== null && report.summary.errors + report.summary.warnings > 0;
    els.fix.hidden = !(canEdit && worth);
    els.fix.disabled = dirty || busy;
    renderProposal();
  }

  async function loadProfiles() {
    if (profilesRequested) return;
    profilesRequested = true;
    try {
      profiles = await fetchProfiles();
      profilesFailed = false;
      renderProfiles();
    } catch (error) {
      profilesFailed = true;
      profilesRequested = false; // se reintenta la próxima vez que se muestre el panel
      setStatus(describe(error));
    }
    render();
  }

  async function check() {
    const ctx = context();
    if (ctx === null || busy || ctx.dirty || els.profile.value === "") return;
    busy = true;
    const mine = epoch;
    setStatus(t("quality.checking"));
    render();
    try {
      const result = await fetchReport({ jobId: ctx.job.id, profile: els.profile.value });
      if (mine !== epoch) return;
      report = result;
      proposal = null;
      setStatus("");
      renderReport();
      announce(els.summary.textContent);
    } catch (error) {
      if (mine !== epoch) return;
      report = null;
      renderReport();
      setStatus(describe(error));
    } finally {
      if (mine === epoch) {
        busy = false;
        render();
      }
    }
  }

  async function propose() {
    const ctx = context();
    if (ctx === null || busy || !canEdit) return;
    busy = true;
    const mine = epoch;
    setStatus(t("quality.fixing"));
    render();
    try {
      const result = await fetchFix({ jobId: ctx.job.id, profile: els.profile.value });
      if (mine !== epoch) return;
      proposal = result;
      setStatus("");
      announce(t("quality.proposal.title"));
    } catch (error) {
      if (mine !== epoch) return;
      setStatus(describe(error));
    } finally {
      if (mine === epoch) {
        busy = false;
        render();
      }
    }
  }

  async function apply() {
    const ctx = context();
    if (ctx === null || busy || proposal === null || proposal.edits.length === 0) return;
    const current = proposal;
    busy = true;
    const mine = epoch;
    setStatus("");
    render();
    let applied = false;
    try {
      await applyEdits({ jobId: ctx.job.id, edits: current.edits, etag: current.etag });
      applied = true;
    } catch (error) {
      if (mine !== epoch) return;
      proposal = null;
      report = null;
      renderReport();
      setStatus(error instanceof ApiError && error.status === 409 ? t("quality.stale") : describe(error));
    } finally {
      if (mine === epoch && !applied) {
        busy = false;
        render();
      }
    }
    if (!applied || mine !== epoch) return;
    proposal = null;
    await onApplied(); // recarga los subtítulos del editor con lo guardado
    announce(t("quality.applied", { count: current.edits.length }));
    busy = false;
    await check(); // el informe nuevo confirma qué mejoró
  }

  els.check.addEventListener("click", () => void check());
  els.fix.addEventListener("click", () => void propose());
  els.apply.addEventListener("click", () => void apply());
  els.discard.addEventListener("click", () => {
    proposal = null;
    render();
    els.fix.focus?.();
  });
  els.profile.addEventListener("change", () => {
    renderProfileNote();
    // otra norma, otro informe: el anterior ya no corresponde
    report = null;
    proposal = null;
    renderReport();
    render();
  });

  return {
    /** Muestra u oculta el panel según haya transcripción abierta; al cambiar de transcripción limpia lo de la anterior. */
    refreshForm() {
      const ctx = context();
      const id = ctx?.job.id ?? null;
      if (id !== currentJob) {
        reset();
        currentJob = id;
      }
      render();
      if (ctx !== null) void loadProfiles();
    },
    /** @param {typeof t} next */
    refresh(next) {
      t = next;
      renderProfiles();
      renderReport();
      render();
    },
    /** Para pruebas y para el cierre: ¿hubo un fallo al cargar las normas? */
    get profilesFailed() {
      return profilesFailed;
    },
  };
}
