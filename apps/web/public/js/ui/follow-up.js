// «Sube y olvídate» en el cliente (v1.3.0, fase 1): al terminar la transcripción de un archivo, pide el quemado que su plan encadenó.
// Es orquestación del navegador, no del servidor: si se cierra la pestaña, el encadenado se pierde (la transcripción y el botón manual
// de «Crear video con subtítulos» siguen ahí). Por eso la interfaz lo avisa y `pending()` alimenta el aviso al salir de la página.
//
// Solo se encadena el quemado, una sola vez por archivo, y un fallo (409, 413, red) se avisa sin reintentar: nunca hay bucles.

import { ApiError } from "../api/errors.js";
import { getJob, startBurn } from "../api/jobs.js";

/** Cada cuánto se consulta UN trabajo de los registrados que el seguimiento principal no ve (por turnos, para no saturar el límite de peticiones). */
const POLL_MS = 2000;

/**
 * @param {{
 *   baseUrl: string,
 *   start?: typeof startBurn,
 *   fetchJob?: typeof getJob,
 *   onStarted: (job: import("../api/sse.js").JobView, parentName: string) => void,
 *   onProblem: (problem: { code: string, name: string, jobId: string, retryAfter?: number }) => void,
 *   onPendingChange: (count: number) => void,
 *   setInterval?: (fn: () => unknown, ms: number) => any,
 *   clearInterval?: (id: any) => void,
 * }} deps
 */
export function createFollowUp({ baseUrl, start = startBurn, fetchJob = getJob, onStarted, onProblem, onPendingChange, setInterval: every = (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: stopEvery = (id) => globalThis.clearInterval(id) }) {
  /** @type {Map<string, { burn: { canvas: string, template?: string, style?: string } }>} */
  const wanted = new Map();
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {any} */
  let timer = null;
  let ticking = false;
  let turn = 0;

  const changed = () => {
    onPendingChange(wanted.size);
    if (wanted.size === 0 && timer !== null) {
      stopEvery(timer);
      timer = null;
    }
  };

  function forget(/** @type {string} */ jobId) {
    wanted.delete(jobId);
    names.delete(jobId);
    changed();
  }

  /** Quita el encadenado ANTES de esperar al servidor: dos eventos iguales seguidos no pueden pedir dos quemados. */
  async function fire(/** @type {string} */ jobId) {
    const followUp = wanted.get(jobId);
    const name = names.get(jobId) ?? "";
    forget(jobId);
    if (!followUp) return;
    const burn = followUp.burn;
    try {
      const job = await start({ baseUrl, jobId, ...(burn.canvas === "vertical" ? { canvas: "vertical", template: burn.template } : { style: burn.style }) });
      try {
        onStarted(job, name);
      } catch (error) {
        console.error(error); // el quemado ya existe en el servidor: queda en «Recientes» aunque la pantalla falle
      }
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      const failure = error instanceof ApiError ? error : ApiError.network();
      onProblem({ code: failure.code, name, jobId, ...(failure.retryAfter != null ? { retryAfter: failure.retryAfter } : {}) });
    }
  }

  /** @param {{ id?: string, kind?: string, status?: string } | null | undefined} job */
  function onJob(job) {
    if (!job || typeof job.id !== "string" || job.kind !== "TRANSCRIBE" || !wanted.has(job.id)) return;
    if (job.status === "COMPLETED") void fire(job.id);
    else if (job.status === "FAILED" || job.status === "CANCELLED") forget(job.id);
  }

  async function tick() {
    if (ticking || wanted.size === 0) return;
    ticking = true;
    try {
      const ids = [...wanted.keys()];
      const jobId = ids[turn++ % ids.length];
      if (jobId === undefined) return;
      try {
        onJob(await fetchJob({ baseUrl, jobId }));
      } catch (error) {
        if (error instanceof ApiError && error.code === "not_found") forget(jobId); // el servidor ya no lo tiene
        // cualquier otro fallo de consulta es pasajero: se vuelve a intentar en el siguiente turno
      }
    } finally {
      ticking = false;
    }
  }

  return {
    /** @param {string} jobId @param {{ burn: { canvas: string, template?: string, style?: string } } | null} followUp @param {string} name */
    register(jobId, followUp, name) {
      if (!followUp) return;
      wanted.set(jobId, followUp);
      names.set(jobId, name);
      if (timer === null) timer = every(tick, POLL_MS);
      changed();
    },
    onJob,
    pending: () => wanted.size,
    stop() {
      wanted.clear();
      names.clear();
      changed();
    },
  };
}
