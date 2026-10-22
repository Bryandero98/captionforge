// Estado del editor de subtítulos como funciones puras: lo guardado (con su etag) + los cambios sin guardar por índice.
// Se mandan al API solo los campos que cambiaron (PUT parcial) y con el etag leído: si otro cambió los subtítulos
// entre medias el API responde 409 y no se pisa nada en silencio.

import { MAX_SECONDS, MAX_TEXT_CHARS } from "./limits.js";

/**
 * @typedef {{ index: number, start: number, end: number, text: string, words: unknown[] | null }} Segment
 * @typedef {{ text?: string, start?: number, end?: number }} Draft
 * @typedef {{ segments: Segment[], etag: string, drafts: Record<number, Draft> }} EditorState
 * @typedef {{ index: number, text?: string, start?: number, end?: number }} Edit
 */

/**
 * @param {Segment[]} segments
 * @param {string} etag
 * @returns {EditorState}
 */
export function openEditor(segments, etag) {
  return { segments, etag, drafts: {} };
}

/**
 * @param {EditorState} state
 * @param {number} index
 * @param {Draft} change
 * @returns {EditorState}
 */
function withDraft(state, index, change) {
  const original = state.segments[index];
  if (original === undefined) return state;
  /** @type {Draft} */
  const draft = { ...state.drafts[index], ...change };
  // Volver al valor original deshace el cambio: no se manda nada ni se marca como sucio.
  for (const field of /** @type {const} */ (["text", "start", "end"])) {
    if (draft[field] === original[field]) delete draft[field];
  }
  const drafts = { ...state.drafts };
  if (Object.keys(draft).length === 0) delete drafts[index];
  else drafts[index] = draft;
  return { ...state, drafts };
}

/** @param {EditorState} state @param {number} index @param {string} text */
export function setText(state, index, text) {
  return withDraft(state, index, { text });
}

/** @param {EditorState} state @param {number} index @param {"start" | "end"} field @param {number} seconds */
export function setTime(state, index, field, seconds) {
  return withDraft(state, index, { [field]: seconds });
}

/** @param {EditorState} state */
export function dirtyCount(state) {
  return Object.keys(state.drafts).length;
}

/**
 * Las ediciones a mandar, ordenadas por índice.
 * @param {EditorState} state
 * @returns {Edit[]}
 */
export function editsOf(state) {
  return Object.keys(state.drafts)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => ({ index, ...state.drafts[index] }));
}

/** @param {EditorState} state */
export function discard(state) {
  return { ...state, drafts: {} };
}

/**
 * Adopta lo que devolvió el servidor tras guardar. Los cambios que se hicieron MIENTRAS se guardaba (distintos de lo
 * enviado) siguen pendientes.
 * @param {EditorState} state
 * @param {Segment[]} segments
 * @param {string} etag
 * @param {Edit[]} [sent] lo que se envió; sin él se descarta todo lo pendiente
 * @returns {EditorState}
 */
export function saved(state, segments, etag, sent) {
  /** @type {EditorState} */
  let next = { segments, etag, drafts: {} };
  if (sent === undefined) return next;
  for (const edit of editsOf(state)) {
    const was = sent.find((candidate) => candidate.index === edit.index);
    for (const field of /** @type {const} */ (["text", "start", "end"])) {
      const value = edit[field];
      if (value === undefined || was?.[field] === value) continue;
      next = field === "text" ? setText(next, edit.index, /** @type {string} */ (value)) : setTime(next, edit.index, field, /** @type {number} */ (value));
    }
  }
  // Un campo enviado que, mientras se guardaba, volvió a su valor ANTERIOR ya no figura como borrador, pero el servidor
  // ya tiene el valor enviado: hay que dejar ese retroceso pendiente o se perdería sin aviso.
  for (const was of sent) {
    const original = state.segments[was.index];
    if (original === undefined) continue;
    for (const field of /** @type {const} */ (["text", "start", "end"])) {
      const sentValue = was[field];
      if (sentValue === undefined || state.drafts[was.index]?.[field] !== undefined || original[field] === sentValue) continue;
      next = field === "text" ? setText(next, was.index, /** @type {string} */ (original.text)) : setTime(next, was.index, field, /** @type {number} */ (original[field]));
    }
  }
  return next;
}

/**
 * Problema de UN subtítulo editado que el servidor rechazaría (undefined si no hay).
 * @param {EditorState} state
 * @param {number} index
 * @returns {"range" | "long" | "blank" | undefined}
 */
export function issueOf(state, index) {
  const draft = state.drafts[index];
  const original = state.segments[index];
  if (draft === undefined || original === undefined) return undefined;
  const start = draft.start ?? original.start;
  const end = draft.end ?? original.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start > MAX_SECONDS || end > MAX_SECONDS) return "range";
  const text = draft.text ?? original.text;
  if (text.length > MAX_TEXT_CHARS) return "long";
  // El servidor rechaza una linea en blanco dentro del texto (partiria el bloque del .srt).
  if (/\n[ \t\r]*\n/.test(text.replace(/\r\n/g, "\n"))) return "blank";
  return undefined;
}

/**
 * Problemas de lo editado que el servidor rechazaria: se avisan antes de enviar.
 * @param {EditorState} state
 * @returns {Record<number, "range" | "long" | "blank">}
 */
export function issuesOf(state) {
  /** @type {Record<number, "range" | "long" | "blank">} */
  const issues = {};
  for (const key of Object.keys(state.drafts)) {
    const problem = issueOf(state, Number(key));
    if (problem !== undefined) issues[Number(key)] = problem;
  }
  return issues;
}
