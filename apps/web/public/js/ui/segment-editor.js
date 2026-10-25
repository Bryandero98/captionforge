// Editor de subtítulos: una fila por subtítulo (inicio, fin y texto editables), barra de guardado y manejo del conflicto
// 409. El estado vive en domain/editor-state.js (puro); aquí solo hay DOM. Todo texto entra con textContent o .value.
// Las filas se pintan por tandas: un video largo puede tener miles de subtítulos.
//
// Carreras: cada `open` y `close` suben una «generación». Un guardado o una recarga que vuelve después de que se abrió
// otro trabajo (o se cerró este) compara su generación y se descarta: nunca mezcla datos de un trabajo en otro.

import { ApiError } from "../api/errors.js";
import { getSegments, putSegments } from "../api/jobs.js";
import { applyFixes as applyStateFixes, canUndo as stateCanUndo, currentSegments, dirtyCount, discard, editsOf, issueOf, issuesOf, openEditor, renameSpeaker, saved, setText, setTime, speakerIdsOf, speakerNameOf, speakerOf, undo as stateUndo } from "../domain/editor-state.js";
import { displayName, speakerColor } from "../domain/speakers.js";
import { MAX_SPEAKER_CHARS } from "../domain/limits.js";
import { formatTimestamp, parseTimestamp } from "../domain/subtitles.js";

const CHUNK = 100;

/** @typedef {import("../domain/editor-state.js").EditorState} EditorState */
/** @typedef {import("../domain/editor-state.js").Segment} Segment */

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   onChange: () => void,
 *   save?: typeof putSegments, load?: typeof getSegments,
 * }} deps
 */
export function createSegmentEditor({ doc, win, baseUrl, t, onChange, save = putSegments, load = getSegments }) {
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
    speakers: $("speakers-panel"),
    speakerList: $("speakers-list"),
  };

  /** @type {string | null} */
  let jobId = null;
  /** @type {EditorState | null} */
  let state = null;
  let shown = 0;
  let saving = false;
  let conflict = false;
  let generation = 0;
  /** @type {string | null} */
  let message = null;
  /** Campos de tiempo con un texto que no se pudo leer (`índice:campo`): bloquean guardar hasta corregirlos. @type {Set<string>} */
  const badTimes = new Set();
  /** @typedef {{ row: HTMLElement, start: HTMLInputElement, end: HTMLInputElement, text: HTMLTextAreaElement, issue: HTMLElement, speaker: HTMLElement, marks: HTMLElement }} Row */
  /** @type {Map<number, Row>} */
  const rows = new Map();
  /** Pinta las marcas de calidad de una fila (editor guiado, ADR 0027); sin él las filas no llevan marcas. @type {((index: number, container: HTMLElement) => void) | null} */
  let marker = null;
  /** Avisa de cualquier cambio del estado del editor (el editor guiado vuelve a medir). @type {() => void} */
  let edited = () => {};
  /** Confirma el valor escrito en un campo de tiempo (lo mismo que al salir del campo). @type {WeakMap<EventTarget, () => void>} */
  const commits = new WeakMap();

  /** Nombre legible de un hablante GUARDADO (SPEAKER_01 -> «Hablante 1»; un nombre puesto por la persona, tal cual). */
  const speakerLabel = (/** @type {string} */ name) => displayName(name, (n) => t("speakers.default", { n }));

  /** Identificadores de hablante guardados, por orden de aparición: la posición fija el color aunque se renombre. @type {string[]} */
  let speakerOrder = [];

  function refreshBar() {
    const count = state === null ? 0 : dirtyCount(state);
    els.bar.hidden = state === null;
    els.state.textContent = saving ? t("editor.saving") : message ?? (count > 0 ? t("editor.dirty", { count }) : t("editor.clean"));
    els.save.disabled = saving || count === 0 || conflict;
    els.save.textContent = t("editor.save");
    els.discard.disabled = saving || count === 0;
    els.conflict.hidden = !conflict;
    onChange();
    edited();
  }

  /** Refleja en una fila lo que dice el estado (valor guardado o borrador) y sus avisos. */
  function paintRow(/** @type {number} */ index) {
    const entry = rows.get(index);
    if (entry === undefined || state === null) return;
    const original = /** @type {Segment} */ (state.segments[index]);
    const draft = state.drafts[index];
    for (const [input, field] of /** @type {const} */ ([[entry.start, "start"], [entry.end, "end"]])) {
      if (badTimes.has(`${index}:${field}`)) continue; // se respeta lo que la persona está escribiendo
      input.value = formatTimestamp(draft?.[field] ?? original[field], ".");
    }
    const text = draft?.text ?? original.text;
    if (entry.text.value !== text) entry.text.value = text;
    const who = speakerOf(state, index);
    entry.speaker.hidden = who === undefined;
    if (who !== undefined && original.speaker !== undefined) {
      const name = speakerLabel(who);
      entry.speaker.textContent = name;
      entry.speaker.title = name;
      entry.speaker.className = `seg__speaker speaker-${speakerColor(Math.max(0, speakerOrder.indexOf(original.speaker)))}`;
    }
    entry.row.classList.toggle("is-dirty", draft !== undefined);

    const badStart = badTimes.has(`${index}:start`);
    const badEnd = badTimes.has(`${index}:end`);
    const issue = issueOf(state, index);
    const problem = badStart || badEnd ? "time" : issue;
    entry.issue.hidden = problem === undefined;
    entry.issue.textContent = problem === undefined ? "" : t(`editor.issue.${problem}`);
    // Solo el campo que falla se marca; el aviso de la fila lo describe (aria-describedby).
    entry.start.setAttribute("aria-invalid", String(badStart || issue === "range"));
    entry.end.setAttribute("aria-invalid", String(badEnd || issue === "range"));
    entry.text.setAttribute("aria-invalid", String(issue === "long" || issue === "blank"));
    for (const control of [entry.start, entry.end, entry.text]) {
      if (problem === undefined) control.removeAttribute("aria-describedby");
      else control.setAttribute("aria-describedby", entry.issue.id);
    }
    marker?.(index, entry.marks);
  }

  function mutate(/** @type {number} */ index, /** @type {(current: EditorState) => EditorState} */ change) {
    if (state === null) return;
    // Con un conflicto abierto se siguen aceptando cambios, pero las opciones del conflicto no desaparecen.
    if (!conflict) message = null;
    state = change(state);
    paintRow(index);
    refreshBar();
  }

  function buildRow(/** @type {Segment} */ segment) {
    const index = segment.index;
    const n = index + 1;
    const row = doc.createElement("li");
    row.className = "seg";
    const times = doc.createElement("div");
    times.className = "seg__times";
    const speaker = doc.createElement("span");
    speaker.className = "seg__speaker";
    speaker.hidden = true;
    const makeTime = (/** @type {"start" | "end"} */ field) => {
      const input = doc.createElement("input");
      input.type = "text";
      input.className = "seg__t";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", t(`editor.label.${field}`, { n }));
      const commit = () => {
        const seconds = parseTimestamp(input.value);
        if (seconds === null) {
          badTimes.add(`${index}:${field}`);
          paintRow(index);
          refreshBar();
          return;
        }
        badTimes.delete(`${index}:${field}`);
        // Escribir el mismo valor que ya se ve (con menos decimales) no es un cambio.
        const current = state === null ? null : (state.drafts[index]?.[field] ?? /** @type {Segment} */ (state.segments[index])[field]);
        if (current === null || formatTimestamp(seconds, ".") !== formatTimestamp(current, ".")) mutate(index, (value) => setTime(value, index, field, seconds));
        else paintRow(index);
        input.value = formatTimestamp(seconds, "."); // se normaliza al salir del campo
      };
      commits.set(input, commit);
      input.addEventListener("change", commit);
      return input;
    };
    const start = makeTime("start");
    const end = makeTime("end");
    times.append(start, end, speaker); // el hablante va después de los campos: no cambia su posición
    const text = doc.createElement("textarea");
    text.className = "seg__text";
    text.rows = 1;
    text.setAttribute("aria-label", t("editor.label.text", { n }));
    text.addEventListener("input", () => mutate(index, (current) => setText(current, index, text.value)));
    const issue = doc.createElement("p");
    issue.className = "seg__issue";
    issue.id = `seg-issue-${index}`;
    issue.hidden = true;
    const marks = doc.createElement("div");
    marks.className = "seg__marks";
    row.append(times, text, issue, marks);
    row.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
      if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")) return;
      event.preventDefault();
      // El «change» de un campo de tiempo llega al salir de él: se confirma antes, o Ctrl+S guardaría sin ese cambio.
      if (event.target !== null) commits.get(event.target)?.();
      void persist();
    });
    rows.set(index, { row, start, end, text, issue, speaker, marks });
    return row;
  }

  /** Repinta los subtítulos de un hablante (o todos). */
  function paintSpeaker(/** @type {string | null} */ id) {
    if (state === null) return;
    for (const [index] of rows) if (id === null || state.segments[index]?.speaker === id) paintRow(index);
  }

  /** El panel «Hablantes»: un campo de nombre por hablante guardado. Renombrar cambia todos sus subtítulos (un borrador por subtítulo). */
  function renderSpeakers() {
    if (state === null) {
      speakerOrder = [];
      els.speakers.hidden = true;
      els.speakerList.replaceChildren();
      return;
    }
    speakerOrder = speakerIdsOf(state);
    els.speakers.hidden = speakerOrder.length === 0;
    const items = speakerOrder.map((id, position) => {
      const item = doc.createElement("li");
      item.className = "speakers__item";
      const swatch = doc.createElement("span");
      swatch.className = `speakers__swatch speaker-${speakerColor(position)}`;
      swatch.setAttribute("aria-hidden", "true");
      const input = doc.createElement("input");
      input.type = "text";
      input.className = "speakers__name";
      input.maxLength = MAX_SPEAKER_CHARS;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", t("speakers.label", { name: speakerLabel(id) }));
      const show = () => {
        if (state !== null) input.value = speakerLabel(speakerNameOf(state, id));
      };
      show();
      input.addEventListener("input", () => {
        if (state === null) return;
        if (!conflict) message = null;
        state = renameSpeaker(state, id, input.value);
        paintSpeaker(id);
        refreshBar();
      });
      input.addEventListener("change", show); // al salir, un campo vacío vuelve al nombre que tiene
      item.append(swatch, input);
      return item;
    });
    els.speakerList.replaceChildren(...items);
  }

  function renderRows() {
    if (state === null) return;
    const fragment = doc.createDocumentFragment();
    const limit = Math.min(state.segments.length, shown + CHUNK);
    for (let i = shown; i < limit; i++) fragment.append(buildRow(/** @type {Segment} */ (state.segments[i])));
    const firstNew = shown;
    els.list.append(fragment);
    for (let i = shown; i < limit; i++) paintRow(i);
    shown = limit;
    const remaining = state.segments.length - shown;
    // El botón que se acaba de usar desaparece: el foco pasa a la primera fila nueva.
    if (remaining <= 0 && doc.activeElement === els.more) rows.get(firstNew)?.text.focus();
    els.more.hidden = remaining <= 0;
    els.more.textContent = t("result.more", { count: remaining });
  }

  async function persist(overrideEtag = false) {
    if (state === null || jobId === null || dirtyCount(state) === 0) return;
    if (saving) {
      message = t("editor.saving");
      return;
    }
    const issues = issuesOf(state);
    if (Object.keys(issues).length > 0 || badTimes.size > 0) {
      message = t("editor.blocked");
      refreshBar();
      const first = [...rows.entries()].find(([index]) => issues[index] !== undefined || badTimes.has(`${index}:start`) || badTimes.has(`${index}:end`));
      /** @type {HTMLElement | null | undefined} */ (first?.[1].row.querySelector("[aria-invalid=true]"))?.focus();
      return;
    }
    const mine = generation;
    const id = jobId;
    const before = state;
    saving = true;
    conflict = false;
    message = null;
    refreshBar();
    const sent = editsOf(before);
    try {
      let etag = before.etag;
      if (overrideEtag) {
        // El usuario eligió sobrescribir: se usa la versión actual del servidor.
        etag = (await load({ baseUrl, jobId: id })).etag;
        if (mine !== generation) return;
      }
      const result = await save({ baseUrl, jobId: id, edits: sent, etag });
      if (mine !== generation || state === null) return; // se abrió otro trabajo o se cerró este: la respuesta ya no aplica
      state = saved(state, result.segments, result.etag, sent);
      renderSpeakers();
      paintSpeaker(null);
      for (const edit of sent) paintRow(edit.index);
      message = dirtyCount(state) > 0 ? null : t("editor.saved");
    } catch (error) {
      if (mine !== generation) return;
      if (!(error instanceof ApiError)) console.error(error);
      if (error instanceof ApiError && error.code === "conflict") {
        conflict = true;
        message = t("editor.conflict");
      } else {
        const code = error instanceof ApiError ? error.code : "network";
        message = `${t("editor.failed")} ${t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 })}`;
      }
    } finally {
      if (mine === generation) {
        saving = false;
        refreshBar();
      }
    }
  }

  els.save.addEventListener("click", () => void persist());
  els.discard.addEventListener("click", () => {
    if (state === null) return;
    state = discard(state);
    badTimes.clear();
    message = null;
    conflict = false;
    renderSpeakers();
    for (const index of rows.keys()) paintRow(index);
    refreshBar();
  });
  els.more.addEventListener("click", renderRows);
  els.overwrite.addEventListener("click", () => void persist(true));
  els.reload.addEventListener("click", async () => {
    if (jobId === null || (dirtyCount(state ?? openEditor([], "")) > 0 && !win.confirm(t("editor.reload.confirm")))) return;
    const mine = generation;
    const id = jobId;
    try {
      const fresh = await load({ baseUrl, jobId: id });
      if (mine !== generation) return;
      open(id, fresh.segments, fresh.etag);
      message = t("editor.reloaded");
    } catch (error) {
      if (mine !== generation) return;
      if (!(error instanceof ApiError)) console.error(error);
      message = t(`error.${error instanceof ApiError ? error.code : "network"}`, { seconds: 10 });
    }
    refreshBar();
  });

  /** Abre (o reemplaza) los subtítulos que se editan. */
  function open(/** @type {string} */ id, /** @type {Segment[]} */ segments, /** @type {string} */ etag) {
    generation++;
    jobId = id;
    state = openEditor(segments, etag);
    shown = 0;
    saving = false;
    conflict = false;
    message = null;
    badTimes.clear();
    rows.clear();
    els.list.replaceChildren();
    renderSpeakers();
    renderRows();
    refreshBar();
  }

  return {
    open,
    close() {
      generation++;
      jobId = null;
      state = null;
      shown = 0;
      saving = false;
      conflict = false;
      message = null;
      badTimes.clear();
      rows.clear();
      els.list.replaceChildren();
      renderSpeakers();
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
      if (!els.speakers.contains(doc.activeElement)) renderSpeakers();
      refreshBar();
    },
    persist,
    /** El trabajo abierto, o null. */
    get jobId() {
      return jobId;
    },
    /** Subtítulos tal como se ven ahora (guardado + borrador): start, end y text. */
    currentSegments() {
      return state === null ? [] : currentSegments(state);
    },
    /** Hay algo que el servidor rechazaría (rango, largo, línea en blanco o un tiempo ilegible): no se mide hasta corregirlo. */
    get hasLocalIssues() {
      return state !== null && (badTimes.size > 0 || Object.keys(issuesOf(state)).length > 0);
    },
    /** @param {(index: number, container: HTMLElement) => void} fn */
    setMarker(fn) {
      marker = fn;
      for (const index of rows.keys()) paintRow(index);
    },
    /** @param {() => void} fn */
    onEdited(fn) {
      edited = fn;
    },
    repaintMarks() {
      for (const [index, entry] of rows) marker?.(index, entry.marks);
    },
    /** Escribe arreglos como borradores (no guarda) en un solo paso de deshacer. @param {{ index: number, edit: { text?: string, start?: number, end?: number } }[]} fixes */
    applyFixes(fixes) {
      if (state === null) return;
      const next = applyStateFixes(state, fixes);
      if (next === state) return;
      for (const { index, edit } of fixes) {
        if (edit.start !== undefined) badTimes.delete(`${index}:start`);
        if (edit.end !== undefined) badTimes.delete(`${index}:end`);
      }
      if (!conflict) message = null;
      state = next;
      for (const { index } of fixes) paintRow(index);
      refreshBar();
    },
    /** Revierte el último arreglo. Devuelve los índices tocados (para devolver el foco). */
    undo() {
      if (state === null || !stateCanUndo(state)) return [];
      const touched = (state.undo.at(-1) ?? []).map((change) => change.index);
      if (!conflict) message = null;
      state = stateUndo(state);
      for (const index of touched) {
        badTimes.delete(`${index}:start`);
        badTimes.delete(`${index}:end`);
        paintRow(index);
      }
      refreshBar();
      return touched;
    },
    get canUndo() {
      return state !== null && stateCanUndo(state);
    },
    /** Lleva el foco al texto de un subtítulo, pintando las filas que falten. @param {number} index */
    focusSegment(index) {
      if (state === null || index < 0 || index >= state.segments.length) return;
      while (shown <= index) renderRows();
      const entry = rows.get(index);
      entry?.row.scrollIntoView?.({ block: "center" });
      entry?.text.focus();
    },
    /** Nombre legible del hablante de un subtítulo GUARDADO, o null si no tiene. @param {{ speaker?: string }} segment */
    speakerNameOf(segment) {
      return typeof segment.speaker === "string" && segment.speaker !== "" ? speakerLabel(segment.speaker) : null;
    },
  };
}
