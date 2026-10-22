// Seguimiento de UN trabajo: une el estado puro (domain/job-state.js) con el cliente SSE (api/sse.js) y sus carreras.
// Hay un seguimiento para la transcripción abierta y otro para el quemado; cada uno es una instancia de esto.
// Cortar el seguimiento no cancela el trabajo: este vive en el servidor.

import { ApiError } from "../api/errors.js";
import { followJob, isTerminalStatus } from "../api/sse.js";
import { initialTracking, trackingReduce } from "../domain/job-state.js";

/**
 * @param {{
 *   baseUrl: string,
 *   follower?: typeof followJob,
 *   onChange: () => void,
 * }} deps
 */
export function createTracker({ baseUrl, follower = followJob, onChange }) {
  let state = initialTracking;
  /** @type {AbortController | null} */
  let controller = null;

  /** @param {Parameters<typeof trackingReduce>[1]} event */
  function dispatch(event) {
    state = trackingReduce(state, event);
    onChange();
  }

  function abort() {
    controller?.abort();
    controller = null;
  }

  /** @param {unknown} error */
  function lost(error) {
    if (!(error instanceof ApiError)) console.error(error);
    try {
      dispatch({ type: "lost", error: error instanceof ApiError ? error : ApiError.network() });
    } catch (renderError) {
      console.error(renderError);
    }
  }

  /**
   * Sigue el trabajo hasta un estado final. Volver a seguir el mismo trabajo conserva lo último que se vio.
   * @param {string} jobId
   */
  async function follow(jobId) {
    abort();
    const mine = new AbortController();
    controller = mine;
    // Los avisos de un seguimiento ya reemplazado se ignoran aunque el follower no respete la señal.
    const current = (/** @type {() => void} */ action) => {
      if (!mine.signal.aborted) action();
    };
    dispatch({ type: state.jobId === jobId ? "resume" : "track", jobId });
    try {
      await follower({
        baseUrl,
        jobId,
        signal: mine.signal,
        onJob: (job) => current(() => dispatch({ type: "job", job })),
        onConnection: (connection) => current(() => dispatch({ type: "connection", state: connection })),
      });
    } catch (error) {
      if (mine.signal.aborted) return; // se dejó de seguir a propósito
      lost(error);
    } finally {
      if (controller === mine) controller = null;
    }
  }

  /**
   * Abre un trabajo ya existente: lee su estado; si sigue en curso lo sigue, y si terminó muestra su estado final.
   * Devuelve el trabajo, o null si falló o si otra apertura lo reemplazó mientras se leía (`replaced`).
   * @param {string} jobId
   * @param {typeof import("../api/jobs.js").getJob} fetchJob
   * @returns {Promise<{ job: import("../api/sse.js").JobView | null, replaced: boolean }>}
   */
  async function open(jobId, fetchJob) {
    abort();
    const mine = new AbortController();
    controller = mine;
    dispatch({ type: "track", jobId });
    try {
      const job = await fetchJob({ baseUrl, jobId, signal: mine.signal });
      if (mine.signal.aborted) return { job: null, replaced: true };
      dispatch({ type: "job", job });
      if (!isTerminalStatus(job.status)) void follow(jobId);
      return { job, replaced: false };
    } catch (error) {
      if (mine.signal.aborted) return { job: null, replaced: true };
      lost(error);
      return { job: null, replaced: false };
    } finally {
      if (controller === mine) controller = null;
    }
  }

  return {
    get state() {
      return state;
    },
    dispatch,
    follow,
    open,
    /** Deja de seguir y olvida el trabajo. */
    stop() {
      abort();
      state = initialTracking;
      onChange();
    },
  };
}
