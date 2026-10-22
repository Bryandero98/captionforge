// Seguimiento de un trabajo como estado puro: eventos del flujo SSE -> estado -> vista. Sin DOM ni red.
//
//   none --track--> queued --job(RUNNING)--> running --job(COMPLETED|FAILED|CANCELLED)--> estado final
//                      \_______________ lost (no se pudo seguir; el trabajo sigue en el servidor) ______/

/**
 * @typedef {import("../api/sse.js").JobView} JobView
 * @typedef {{
 *   jobId: string | null,
 *   job: JobView | null,
 *   connection: "connecting" | "live" | "reconnecting" | "waiting",
 *   waitSeconds: number,
 *   lost: import("../api/errors.js").ApiError | null,
 * }} Tracking
 */

/** @type {Tracking} */
export const initialTracking = Object.freeze({ jobId: null, job: null, connection: "connecting", waitSeconds: 0, lost: null });

const FINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const isFinal = (/** @type {Tracking} */ state) => state.job !== null && FINAL.has(state.job.status);

/**
 * @param {Tracking} state
 * @param {{ type: "track", jobId: string }
 *   | { type: "resume", jobId: string }
 *   | { type: "job", job: JobView }
 *   | { type: "connection", state: { kind: "connecting" | "reconnecting" | "live" } | { kind: "waiting", seconds: number } }
 *   | { type: "lost", error: import("../api/errors.js").ApiError }
 *   | { type: "reset" }} event
 * @returns {Tracking}
 */
export function trackingReduce(state, event) {
  switch (event.type) {
    case "track":
      return { ...initialTracking, jobId: event.jobId };
    case "resume":
      // Volver a conectar al mismo trabajo conserva lo último que se vio: el panel no retrocede a «en cola».
      if (state.jobId !== event.jobId) return { ...initialTracking, jobId: event.jobId };
      return { ...state, lost: null, connection: "connecting", waitSeconds: 0 };
    case "job":
      if (state.jobId === null || event.job.id !== state.jobId || isFinal(state)) return state;
      return { ...state, job: event.job, lost: null };
    case "connection":
      if (state.jobId === null || isFinal(state)) return state;
      return { ...state, connection: event.state.kind, waitSeconds: event.state.kind === "waiting" ? event.state.seconds : 0 };
    case "lost":
      if (state.jobId === null || isFinal(state)) return state;
      return { ...state, lost: event.error };
    case "reset":
      return initialTracking;
    default:
      return state;
  }
}

/**
 * Lo que la interfaz necesita.
 * @param {Tracking} state
 */
export function trackingViewOf(state) {
  if (state.jobId === null) return { kind: /** @type {const} */ ("none"), terminal: false, stage: null, percent: 0, indeterminate: true, connection: state.connection, waitSeconds: 0, failure: null, error: null, message: null };
  const job = state.job;
  const status = job?.status ?? "QUEUED";
  /** @type {"queued" | "running" | "completed" | "failed" | "cancelled" | "lost"} */
  let kind = "queued";
  if (status === "RUNNING") kind = "running";
  else if (status === "COMPLETED") kind = "completed";
  else if (status === "FAILED") kind = "failed";
  else if (status === "CANCELLED") kind = "cancelled";
  if (state.lost !== null) kind = "lost";
  const terminal = FINAL.has(status);
  // El porcentaje solo vale con etapa: antes de la primera, el worker aún no midió nada.
  const measured = status === "RUNNING" && job !== null && job.stage !== null;
  const percent = status === "COMPLETED" ? 100 : job === null ? 0 : Math.min(99, Math.floor(job.percent));
  return {
    kind,
    terminal,
    stage: job?.stage ?? null,
    percent,
    indeterminate: !terminal && !measured,
    connection: state.connection,
    waitSeconds: state.waitSeconds,
    failure: status === "FAILED" ? { code: job?.error?.code ?? "UNKNOWN", message: job?.error?.message ?? null } : null,
    error: state.lost,
    message: job?.message ?? null,
  };
}
