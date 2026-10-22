// Editor de subtítulos: una fila por subtítulo (inicio, fin y texto editables), barra de guardado y manejo del conflicto
// 409. El estado vive en domain/editor-state.js (puro); aquí solo hay DOM. Todo texto entra con textContent o .value.
// Las filas se pintan por tandas: un video largo puede tener miles de subtítulos.

import { ApiError } from "../api/errors.js";
import { getSegments, putSegments } from "../api/jobs.js";
import { dirtyCount, discard, editsOf, issuesOf, openEditor, saved, setText, setTime } from "../domain/editor-state.js";
import { formatTimestamp, parseTimestamp } from "../domain/subtitles.js";

const CHUNK = 100;

/** @typedef {import("../domain/editor-state.js").EditorState} EditorState */

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   announce: (text: string) => void,
 *   onChange: () => void,
 *   save?: typeof putSegments, load?: typeof getSegments,
 * }} deps
 */
export function createSegmentEditor({ doc, win, baseUrl, t, announce, onChange, save = putSegments, load = getSegments }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    list: $("result-segments"),
    more: $("result-more"),
    bar: $("editor-bar"),
    state: $("editor-state"),
    save: $("editor-save"),
    discard: $("editor-discard"),
    conflict: $("editor-conflict"),
    reload: $("editor-reload"),
    overwrite: $("editor-overwrite"),
  };

  /** @type {string | null} */
  let jobId = null;
  /** @type {EditorState | null} */
  let state = null;
  let shown = 0;
  let saving = false;
  let conflict = false;
  /** @type {string | null} */
  let message = null;
  /** Filas con un tiempo escrito que no se pudo leer: bloquean guardar hasta corregirlo. @type {Set<string>} */
  const badTimes = new Set();
  /** @type {Map<number, { row: HTMLElement, start: HTMLInputElement, end: HTMLInputElement, text: HTMLTextAreaElement, issue: HTMLElement }>} */
  const rows = new Map();

  const issueText = (/** @type {string} */ code) => t(`editor.issue.${code}`);

  function refreshBar() {
    const count = state === null ? 0 : dirtyCount(state);
    els.bar.hidden = state === null;
    els.state.textContent = saving ? t("editor.saving") : message ?? (count > 0 ? t("editor.dirty", { count }) : t("editor.clean"));
    els.save.disabled = saving || count === 0 || conflict;
    els.save.textContent = t("editor.save");
    els.discard.disabled = saving || count === 0;
    els.conflict.hidden = !conflict;
    onChange();
  }

  /** Refleja en una fila lo que dice el estado (valor guardado o borrador) y sus avisos. */
  function paintRow(/** @type {number} */ index) {
    const entry = rows.get(index);
    if (entry === undefined || state === null) return;
    const original = /** @type {import("../domain/editor-state.js").Segment} */ (state.segments[index]);
    const draft = state.drafts[index];
    const issues = issuesOf(state);
    const time = (/** @type {HTMLInputElement} */ input, /** @type {"start" | "end"} */ field) => {
      if (badTimes.has(`${index}:${field}`)) return; // se respeta lo que la persona está escribiendo
      input.value = formatTimestamp(draft?.[field] ?? original[field], ".");
    };
    time(entry.start, "start");
    time(entry.end, "end");
    const text = draft?.text ?? original.text;
    if (entry.text.value !== text) entry.text.value = text;
    entry.row.classList.toggle("is-dirty", draft !== undefined);
    const bad = issues[index];
    const timeBad = badTimes.has(`${index}:start`) || badTimes.has(`${index}:end`);
    const problem = timeBad ? "time" : bad;
    entry.issue.hidden = problem === undefined;
    entry.issue.textContent = problem === undefined ? "" : issueText(problem);
    for (const input of [entry.start, entry.end]) input.setAttribute("aria-invalid", String(problem === "range" || timeBad));
    entry.text.setAttribute("aria-invalid", String(problem === "long"));
  }

  function mutate(/** @type {number} */ index, /** @type {(current: EditorState) => EditorState} */ change) {
    if (state === null) return;
    message = null;
    conflict = false;
    state = change(state);
    paintRow(index);
    refreshBar();
  }

  function buildRow(/** @type {import("../domain/editor-state.js").Segment} */ segment) {
    const index = segment.index;
    const n = index + 1;
    const row = doc.createElement("li");
    row.className = "seg";
    const times = doc.createElement("div");
    times.className = "seg__times";
    const makeTime = (/** @type {"start" | "end"} */ field) => {
      const input = doc.createElement("input");
      input.type = "text";
      input.className = "seg__t";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", t(`editor.label.${field}`, { n }));
      input.addEventListener("change", () => {
        const seconds = parseTimestamp(input.value);
        if (seconds === null) {
          badTimes.add(`${index}:${field}`);
          paintRow(index);
          refreshBar();
          return;
        }
        badTimes.delete(`${index}:${field}`);
        mutate(index, (current) => setTime(current, index, field, seconds));
        input.value = formatTimestamp(seconds, "."); // se normaliza al salir del campo
      });
      return input;
    };
    const start = makeTime("start");
    const end = makeTime("end");
    times.append(start, end);
    const text = doc.createElement("textarea");
    text.className = "seg__text";
    text.rows = 1;
    text.setAttribute("aria-label", t("editor.label.text", { n }));
    text.addEventListener("input", () => {
      mutate(index, (current) => setText(current, index, text.value));
    });
    const issue = doc.createElement("p");
    issue.className = "seg__issue";
    issue.hidden = true;
    row.append(times, text, issue);
    row.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void persist();
      }
    });
    rows.set(index, { row, start, end, text, issue });
    return row;
  }

  function renderRows() {
    if (state === null) return;
    const fragment = doc.createDocumentFragment();
    const limit = Math.min(state.segments.length, shown + CHUNK);
    for (let i = shown; i < limit; i++) fragment.append(buildRow(/** @type {import("../domain/editor-state.js").Segment} */ (state.segments[i])));
    els.list.append(fragment);
    for (let i = shown; i < limit; i++) paintRow(i);
    shown = limit;
    const remaining = state.segments.length - shown;
    els.more.hidden = remaining <= 0;
    els.more.textContent = t("result.more", { count: remaining });
  }

  async function persist(overrideEtag = false) {
    if (state === null || jobId === null || saving || dirtyCount(state) === 0) return;
    const issues = issuesOf(state);
    if (Object.keys(issues).length > 0 || badTimes.size > 0) {
      message = t("editor.blocked");
      refreshBar();
      const first = [...rows.entries()].find(([index]) => issues[index] !== undefined || badTimes.has(`${index}:start`) || badTimes.has(`${index}:end`));
      /** @type {HTMLElement | null | undefined} */ (first?.[1].row.querySelector("[aria-invalid=true]"))?.focus();
      announce(message);
      return;
    }
    saving = true;
    conflict = false;
    message = null;
    refreshBar();
    const sent = editsOf(state);
    try {
      let etag = state.etag;
      if (overrideEtag) etag = (await load({ baseUrl, jobId })).etag; // el usuario eligió sobrescribir: se usa la versión actual
      const result = await save({ baseUrl, jobId, edits: sent, etag });
      state = saved(state, result.segments, result.etag, sent);
      for (const edit of sent) paintRow(edit.index);
      message = t("editor.saved");
      announce(message);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      if (error instanceof ApiError && error.code === "conflict") {
        conflict = true;
        message = t("editor.conflict");
        announce(message);
      } else {
        const code = error instanceof ApiError ? error.code : "network";
        message = `${t("editor.failed")} ${t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 })}`;
        announce(message);
      }
    } finally {
      saving = false;
      refreshBar();
    }
  }

  els.save.addEventListener("click", () => void persist());
  els.discard.addEventListener("click", () => {
    if (state === null) return;
    state = discard(state);
    badTimes.clear();
    message = null;
    conflict = false;
    for (const index of rows.keys()) paintRow(index);
    refreshBar();
  });
  els.more.addEventListener("click", renderRows);
  els.overwrite.addEventListener("click", () => void persist(true));
  els.reload.addEventListener("click", async () => {
    if (jobId === null) return;
    try {
      const fresh = await load({ baseUrl, jobId });
      open(jobId, fresh.segments, fresh.etag);
      message = t("editor.reloaded");
      refreshBar();
      announce(message);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      message = t(`error.${error instanceof ApiError ? error.code : "network"}`, { seconds: 10 });
      refreshBar();
    }
  });

  /** Abre (o reemplaza) los subtítulos que se editan. */
  function open(/** @type {string} */ id, /** @type {import("../domain/editor-state.js").Segment[]} */ segments, /** @type {string} */ etag) {
    jobId = id;
    state = openEditor(segments, etag);
    shown = 0;
    conflict = false;
    message = null;
    badTimes.clear();
    rows.clear();
    els.list.replaceChildren();
    renderRows();
    refreshBar();
  }

  return {
    open,
    close() {
      jobId = null;
      state = null;
      shown = 0;
      conflict = false;
      message = null;
      badTimes.clear();
      rows.clear();
      els.list.replaceChildren();
      els.more.hidden = true;
      refreshBar();
    },
    /** Hay cambios sin guardar. */
    get dirty() {
      return state !== null && dirtyCount(state) > 0;
    },
    /** Los subtítulos guardados en el servidor (sin los borradores). */
    get segments() {
      return state?.segments ?? [];
    },
    /** Repinta los textos que dependen del idioma. */
    refresh() {
      for (const [index, entry] of rows) {
        const n = index + 1;
        entry.start.setAttribute("aria-label", t("editor.label.start", { n }));
        entry.end.setAttribute("aria-label", t("editor.label.end", { n }));
        entry.text.setAttribute("aria-label", t("editor.label.text", { n }));
        paintRow(index);
      }
      if (state !== null) els.more.textContent = t("result.more", { count: Math.max(0, state.segments.length - shown) });
      refreshBar();
    },
    persist,
  };
}
