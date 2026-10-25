// Sesión de medición del editor guiado (ADR 0027). Sin DOM: recibe la función `check` y los temporizadores, de modo que se prueba entera.
//  - Debounce: una ráfaga de ediciones es una sola medición.
//  - Cada medición cancela la anterior (AbortController) y lleva un número de secuencia: una respuesta vieja se descarta aunque llegue tarde.
//  - `fresh` solo es cierto cuando el informe corresponde a lo que hay en pantalla; con `fresh` falso no se aplican arreglos
//    (la edición propuesta se calculó sobre un texto que ya cambió).
//  - Los avisos «ignorados» viven solo en la sesión (no se guardan en ningún sitio).

/** @typedef {import("../api/jobs.js").QualityCheck} Report */
/** @typedef {"idle" | "pending" | "ready" | "paused" | "error"} Status */
/** @typedef {{ status: Status, fresh: boolean, report: Report | null }} Snapshot */

export const DEFAULT_DELAY_MS = 600;

/**
 * @param {{
 *   check: (segments: { start: number, end: number, text: string }[], signal: AbortSignal) => Promise<Report>,
 *   onUpdate?: (snapshot: Snapshot) => void,
 *   delayMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 * }} deps
 */
export function createGuidedSession({ check, onUpdate = () => {}, delayMs = DEFAULT_DELAY_MS, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(/** @type {any} */ (id)) }) {
  /** @type {Status} */
  let status = "idle";
  let fresh = false;
  /** @type {Report | null} */
  let report = null;
  let sequence = 0;
  /** @type {unknown} */
  let timer = null;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Set<string>} */
  const ignored = new Set();

  const snapshot = () => ({ status, fresh, report });
  const emit = () => onUpdate(snapshot());

  function cancelPending() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
    sequence++;
  }

  /** @param {{ start: number, end: number, text: string }[]} segments */
  function run(segments) {
    cancelPending();
    const mine = sequence;
    controller = new AbortController();
    status = "pending";
    fresh = false;
    emit();
    check(segments, controller.signal).then(
      (result) => {
        if (mine !== sequence) return;
        report = result;
        status = "ready";
        fresh = true;
        controller = null;
        emit();
      },
      (error) => {
        if (mine !== sequence || (error instanceof Error && error.name === "AbortError")) return;
        status = "error";
        fresh = false;
        controller = null;
        emit();
      },
    );
  }

  return {
    snapshot,
    /** Mide ya, sin esperar. */
    run,
    /** Mide tras el tiempo de espera; una nueva edición reinicia la cuenta. @param {{ start: number, end: number, text: string }[]} segments */
    schedule(segments) {
      cancelPending();
      fresh = false;
      if (status === "idle" || status === "paused") status = "pending";
      timer = setTimer(() => {
        timer = null;
        run(segments);
      }, delayMs);
      emit();
    },
    /** Hay algo que el servidor rechazaría (rango inválido): no se manda nada hasta corregirlo. */
    pause() {
      cancelPending();
      status = "paused";
      fresh = false;
      emit();
    },
    /** Cancela lo pendiente (p. ej. al cerrar el editor). */
    stop() {
      cancelPending();
    },
    /** Olvida informe e ignorados (otra transcripción). */
    reset() {
      cancelPending();
      status = "idle";
      fresh = false;
      report = null;
      ignored.clear();
      emit();
    },
    /** @param {number} segment @param {string} rule */
    ignore(segment, rule) {
      ignored.add(`${segment}:${rule}`);
      emit();
    },
    unignoreAll() {
      ignored.clear();
      emit();
    },
    ignoredCount: () => ignored.size,
    /** Incidencias del último informe sin las ignoradas. */
    visibleIssues: () => (report?.issues ?? []).filter((issue) => !ignored.has(`${issue.segment}:${issue.rule}`)),
  };
}
