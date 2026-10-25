// Editor guiado por problemas (ADR 0027): cabecera con la nota y las fichas por regla, minimapa lógico de bloques de tiempo,
// marcas en cada fila afectada y arreglos de 1 clic con «Deshacer».
// Reglas de esta pantalla:
//  - Ninguna regla se calcula en el navegador: cada edición se vuelve a medir con POST /quality/check (con espera, cancelación
//    y descarte de respuestas viejas; ver domain/guided-session.js).
//  - Aplicar un arreglo escribe un borrador en el editor (no guarda). Solo se ofrece cuando la medición corresponde a lo que hay en pantalla.
//  - La gravedad se dice con icono Y palabra, nunca solo con color. El minimapa es una lista de botones, sin waveform.
//  - Todo texto entra con textContent; los estilos dinámicos con style.setProperty (CSP sin estilos en línea).

import { checkQuality, getQualityProfiles } from "../api/jobs.js";
import { createGuidedSession } from "../domain/guided-session.js";
import { badgeText, describeFix, describeIssue, headlineChips } from "../domain/quality-summary.js";
import { fixesBySegment, issuesBySegment, minimapBlocks, stepSegment } from "../domain/quality-view.js";

const SPANISH_DEFAULT = "netflix-es";
const GENERIC_DEFAULT = "netflix";
const ICONS = /** @type {const} */ ({ error: "✖", warning: "⚠", info: "ℹ" });

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   lang: () => string, announce: (text: string) => void,
 *   editor: ReturnType<typeof import("./segment-editor.js").createSegmentEditor>,
 *   check?: typeof checkQuality, fetchProfiles?: typeof getQualityProfiles,
 *   session?: ReturnType<typeof createGuidedSession>,
 * }} deps
 */
export function createGuidedEditor({ doc, win, baseUrl, t: initialT, lang, announce, editor, check = checkQuality, fetchProfiles = getQualityProfiles }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    panel: $("guided"), status: $("guided-status"), review: $("guided-review"), profile: $("guided-profile"), chips: $("guided-chips"),
    prev: $("guided-prev"), next: $("guided-next"), undo: $("guided-undo"), fixAll: $("guided-fix-all"), unignore: $("guided-unignore"),
    map: $("guided-map"), mapLabel: $("guided-map-label"),
  };

  let t = initialT;
  const number = (/** @type {number} */ value, max = 1) => new Intl.NumberFormat(lang(), { maximumFractionDigits: max }).format(value);

  /** @type {import("../api/jobs.js").QualityProfile[]} */
  let profiles = [];
  let profilesRequested = false;
  /** @type {string | null} */
  let language = null;
  /** @type {number | null} */
  let cursor = null;
  /** Firma de lo último que se mandó a medir: si la edición no cambió el contenido, no se vuelve a pedir. */
  let lastSignature = "";
  /** @type {Map<number, import("../api/jobs.js").QualityIssue[]>} */
  let bySegment = new Map();
  /** @type {Map<number, import("../api/jobs.js").QualityCheckFix>} */
  let fixes = new Map();
  let jobId = /** @type {string | null} */ (null);

  const session = createGuidedSession({
    check: (segments, signal) => {
      if (jobId === null || els.profile.value === "") return Promise.reject(new Error("sin trabajo o sin norma"));
      return check({ baseUrl, jobId, profile: els.profile.value, segments, signal });
    },
    onUpdate: () => render(),
  });

  const signatureOf = (/** @type {{ start: number, end: number, text: string }[]} */ segments) => JSON.stringify(segments);

  function measureNow() {
    if (jobId === null) return;
    const segments = editor.currentSegments();
    lastSignature = signatureOf(segments);
    if (editor.hasLocalIssues) session.pause();
    else session.run(segments);
  }

  /** Reacciona a cualquier cambio del editor: mide de nuevo solo si el contenido cambió. */
  function onEdited() {
    if (jobId === null || els.panel.hidden) return;
    if (editor.hasLocalIssues) {
      if (session.snapshot().status !== "paused") session.pause();
      return;
    }
    const segments = editor.currentSegments();
    const signature = signatureOf(segments);
    if (signature === lastSignature && session.snapshot().status !== "paused") return;
    lastSignature = signature;
    session.schedule(segments);
  }

  // ---------- marcas por fila ----------

  /** @param {number} index @param {HTMLElement} container */
  function mark(index, container) {
    container.replaceChildren();
    const issues = bySegment.get(index) ?? [];
    container.hidden = issues.length === 0;
    if (issues.length === 0) return;
    for (const issue of issues) {
      const flag = doc.createElement("p");
      flag.className = `seg__flag seg__flag--${issue.severity}`;
      const icon = doc.createElement("span");
      icon.className = "seg__flag-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = ICONS[issue.severity];
      const word = doc.createElement("strong");
      word.textContent = t(`quality.severity.${issue.severity}`);
      const text = doc.createElement("span");
      text.textContent = describeIssue(issue, t, number);
      const ignore = doc.createElement("button");
      ignore.type = "button";
      ignore.className = "btn btn--ghost btn--small";
      ignore.textContent = t("guided.ignore");
      ignore.setAttribute("aria-label", t("guided.ignore.label", { n: index + 1, message: describeIssue(issue, t, number) }));
      ignore.addEventListener("click", () => {
        session.ignore(issue.segment, issue.rule);
        editor.focusSegment(index);
      });
      flag.append(icon, word, doc.createTextNode(" "), text, doc.createTextNode(" "), ignore);
      container.append(flag);
    }
    const fix = fixes.get(index);
    if (fix !== undefined && session.snapshot().fresh) {
      const parts = describeFix(fix, t, number);
      if (parts.length > 0) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "btn btn--secondary btn--small seg__fix";
        button.textContent = t("guided.fix", { what: parts.join(" · ") });
        button.addEventListener("click", () => applyOne(index));
        container.append(button);
      }
    }
  }

  /** @param {number} index */
  function applyOne(index) {
    const fix = fixes.get(index);
    if (fix === undefined || !session.snapshot().fresh) return;
    editor.applyFixes([{ index, edit: fix.edit }]);
    announce(t("guided.fixed.one", { n: index + 1 }));
    editor.focusSegment(index);
  }

  /** @param {(fix: import("../api/jobs.js").QualityCheckFix) => boolean} wanted */
  function applyMany(wanted) {
    const snapshot = session.snapshot();
    if (!snapshot.fresh || snapshot.report === null) return;
    const list = snapshot.report.fixes.filter(wanted);
    if (list.length === 0) return;
    editor.applyFixes(list.map((fix) => ({ index: fix.segment, edit: fix.edit })));
    announce(t("guided.fixed.many", { count: list.length }));
    const first = list[0];
    if (first !== undefined) editor.focusSegment(first.segment);
  }

  // ---------- pintado ----------

  function renderStatus() {
    const { status, report, fresh } = session.snapshot();
    let text = "";
    if (status === "paused") text = t("guided.paused");
    else if (report === null) text = status === "error" ? t("guided.error") : t("guided.measuring");
    else if (status === "error") text = `${t("guided.error")} ${badgeText(report.summary, t)}`;
    else text = fresh ? badgeText(report.summary, t) : `${t("guided.measuring")} ${badgeText(report.summary, t)}`;
    if (els.status.textContent !== text) els.status.textContent = text;
  }

  function renderChips(/** @type {import("../api/jobs.js").QualityIssue[]} */ issues) {
    const { fresh, report } = session.snapshot();
    const items = headlineChips(issues, t).map((chip) => {
      const item = doc.createElement("li");
      item.className = `guided__chip guided__chip--${chip.severity}`;
      const go = doc.createElement("button");
      go.type = "button";
      go.className = "btn btn--ghost btn--small guided__chip-go";
      const icon = doc.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = `${ICONS[chip.severity]} `;
      const label = doc.createElement("span");
      label.textContent = chip.text;
      go.append(icon, label);
      go.setAttribute("aria-label", `${t(`quality.severity.${chip.severity}`)}: ${chip.text}`);
      go.addEventListener("click", () => {
        const target = stepSegment(chip.segments, cursor, 1);
        if (target === null) return;
        cursor = target;
        editor.focusSegment(target);
      });
      item.append(go);
      const fixable = fresh && (report?.fixes ?? []).some((fix) => fix.rules.includes(chip.rule));
      if (fixable) {
        const all = doc.createElement("button");
        all.type = "button";
        all.className = "btn btn--secondary btn--small";
        all.textContent = t("guided.fix.rule");
        all.setAttribute("aria-label", t("guided.fix.rule.label", { what: chip.text }));
        all.addEventListener("click", () => applyMany((fix) => fix.rules.includes(chip.rule)));
        item.append(all);
      }
      return item;
    });
    els.chips.replaceChildren(...items);
  }

  function renderMap(/** @type {import("../api/jobs.js").QualityIssue[]} */ issues) {
    const segments = editor.currentSegments();
    const blocks = minimapBlocks({ segments, issues, widthPx: els.map.clientWidth || win.innerWidth || 480 });
    els.mapLabel.hidden = blocks.length === 0;
    const items = blocks.map((block) => {
      const item = doc.createElement("li");
      item.className = "guided__mark-item";
      item.style.setProperty("--left", `${block.leftPct}%`);
      item.style.setProperty("--width", `${block.widthPct}%`);
      const button = doc.createElement("button");
      button.type = "button";
      button.className = `guided__mark guided__mark--${block.severity}`;
      button.textContent = block.count > 1 ? String(block.count) : ICONS[block.severity];
      button.setAttribute("aria-label", t("guided.mark", { n: block.first + 1, count: block.count, severity: t(`quality.severity.${block.severity}`) }));
      button.addEventListener("click", () => {
        cursor = block.first;
        editor.focusSegment(block.first);
      });
      item.append(button);
      return item;
    });
    els.map.replaceChildren(...items);
    els.map.hidden = items.length === 0;
  }

  function render() {
    if (jobId === null) return;
    const snapshot = session.snapshot();
    const issues = session.visibleIssues();
    bySegment = issuesBySegment(issues);
    fixes = fixesBySegment(snapshot.report?.fixes ?? []);
    renderStatus();
    renderChips(issues);
    renderMap(issues);
    editor.repaintMarks();
    const affected = [...bySegment.keys()].sort((a, b) => a - b);
    els.prev.disabled = affected.length === 0;
    els.next.disabled = affected.length === 0;
    els.review.disabled = affected.length === 0;
    els.undo.disabled = !editor.canUndo;
    els.fixAll.disabled = !snapshot.fresh || (snapshot.report?.fixes.length ?? 0) === 0;
    els.unignore.hidden = session.ignoredCount() === 0;
    els.unignore.textContent = t("guided.unignore", { count: session.ignoredCount() });
  }

  // ---------- eventos ----------

  /** @param {1 | -1} direction */
  function step(direction) {
    const target = stepSegment([...bySegment.keys()].sort((a, b) => a - b), cursor, direction);
    if (target === null) return;
    cursor = target;
    editor.focusSegment(target);
  }

  els.review.addEventListener("click", () => step(1));
  els.next.addEventListener("click", () => step(1));
  els.prev.addEventListener("click", () => step(-1));
  els.fixAll.addEventListener("click", () => applyMany(() => true));
  els.undo.addEventListener("click", () => {
    const touched = editor.undo();
    if (touched.length === 0) return;
    announce(t("guided.undone"));
    editor.focusSegment(/** @type {number} */ (touched[0]));
  });
  els.unignore.addEventListener("click", () => session.unignoreAll());
  els.profile.addEventListener("change", () => measureNow());
  win.addEventListener("resize", () => {
    if (jobId !== null) renderMap(session.visibleIssues());
  });
  editor.setMarker(mark);
  editor.onEdited(onEdited);

  async function loadProfiles() {
    if (profilesRequested) return;
    profilesRequested = true;
    try {
      profiles = await fetchProfiles({ baseUrl });
    } catch {
      profiles = [];
      profilesRequested = false;
    }
    const keep = els.profile.value;
    const has = (/** @type {string} */ id) => profiles.some((profile) => profile.id === id);
    els.profile.replaceChildren(
      ...profiles.map((profile) => {
        const option = doc.createElement("option");
        option.value = profile.id;
        option.textContent = profile.label;
        return option;
      }),
    );
    const preferred = language === "es" ? SPANISH_DEFAULT : GENERIC_DEFAULT;
    els.profile.value = has(keep) ? keep : has(preferred) ? preferred : (profiles[0]?.id ?? "");
  }

  return {
    /** Se llama cuando el editor cargó los subtítulos de una transcripción: empieza a medir. @param {string} id @param {string | null} lang */
    async open(id, lang) {
      session.reset();
      jobId = id;
      language = lang;
      cursor = null;
      lastSignature = "";
      els.panel.hidden = false;
      await loadProfiles();
      if (jobId !== id) return; // se abrió otro trabajo mientras llegaban las normas
      if (els.profile.value === "") {
        els.status.textContent = t("guided.error");
        return;
      }
      measureNow();
    },
    close() {
      jobId = null;
      session.reset();
      bySegment = new Map();
      fixes = new Map();
      els.panel.hidden = true;
      els.chips.replaceChildren();
      els.map.replaceChildren();
    },
    /** La nota actual para la insignia del resultado, o null si aún no hay medición. */
    get badge() {
      const { report } = session.snapshot();
      return report === null ? null : badgeText(report.summary, t);
    },
    /** Repinta los textos que dependen del idioma. @param {typeof t} next */
    refresh(next) {
      t = next;
      if (jobId === null) return;
      render();
    },
  };
}
