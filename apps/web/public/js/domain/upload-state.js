// Estado de una subida como máquina de estados pura: eventos -> estado -> vista. Sin DOM ni red, para probarla a fondo.
//
//   idle --start--> uploading --sent--> finalizing --accepted--> queued
//                      |  ^                |
//                      |  +--progress      +--failed--> error | cancelled
//                      +--failed------------------------^
//   error | cancelled | queued --start--> uploading      (cualquiera --reset--> idle)

/** Peso de la muestra nueva en la media móvil de la velocidad. */
const SMOOTHING = 0.3;

/**
 * @typedef {"idle" | "uploading" | "finalizing" | "queued" | "error" | "cancelled"} Phase
 * @typedef {{
 *   phase: Phase,
 *   file: { name: string, size: number } | null,
 *   loaded: number,
 *   total: number,
 *   fraction: number,
 *   bytesPerSecond: number,
 *   etaSeconds: number | null,
 *   job: { id: string } | null,
 *   error: import("../api/errors.js").ApiError | null,
 *   sampleAt: number,
 *   sampleLoaded: number,
 * }} UploadState
 */

/** @type {UploadState} */
export const initialState = Object.freeze({
  phase: "idle",
  file: null,
  loaded: 0,
  total: 0,
  fraction: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
  job: null,
  error: null,
  sampleAt: 0,
  sampleLoaded: 0,
});

const isBusy = (/** @type {Phase} */ phase) => phase === "uploading" || phase === "finalizing";

/**
 * @param {UploadState} state
 * @param {{ type: "start", file: { name: string, size: number }, at: number }
 *   | { type: "progress", loaded: number, total: number, at: number }
 *   | { type: "sent", at?: number }
 *   | { type: "accepted", job: { id: string } }
 *   | { type: "failed", error: import("../api/errors.js").ApiError }
 *   | { type: "reset" }} event
 * @returns {UploadState}
 */
export function reduce(state, event) {
  switch (event.type) {
    case "start":
      if (isBusy(state.phase)) return state;
      return { ...initialState, phase: "uploading", file: event.file, total: event.file.size, sampleAt: event.at };

    case "progress": {
      if (state.phase !== "uploading") return state;
      const total = event.total > 0 ? event.total : state.total;
      const loaded = Math.max(state.loaded, event.loaded);
      const fraction = total > 0 ? Math.max(state.fraction, Math.min(1, loaded / total)) : state.fraction;
      let { bytesPerSecond, sampleAt, sampleLoaded } = state;
      const elapsed = event.at - sampleAt;
      if (elapsed > 0 && loaded > sampleLoaded) {
        const instant = ((loaded - sampleLoaded) / elapsed) * 1000;
        bytesPerSecond = bytesPerSecond > 0 ? SMOOTHING * instant + (1 - SMOOTHING) * bytesPerSecond : instant;
        sampleAt = event.at;
        sampleLoaded = loaded;
      }
      const etaSeconds = bytesPerSecond > 0 && total > loaded ? (total - loaded) / bytesPerSecond : null;
      return { ...state, loaded, total, fraction, bytesPerSecond, etaSeconds, sampleAt, sampleLoaded };
    }

    case "sent":
      if (state.phase !== "uploading") return state;
      return { ...state, phase: "finalizing", fraction: 1, loaded: state.total, etaSeconds: null };

    case "accepted":
      if (!isBusy(state.phase)) return state;
      return { ...state, phase: "queued", fraction: 1, job: event.job, etaSeconds: null };

    case "failed":
      if (!isBusy(state.phase)) return state;
      // Cancelar no es un fallo: no se enseña un error rojo a quien acaba de pulsar «Cancelar».
      if (event.error.code === "aborted") return { ...state, phase: "cancelled", error: null, etaSeconds: null };
      return { ...state, phase: "error", error: event.error, etaSeconds: null };

    case "reset":
      return initialState;

    default:
      return state;
  }
}

/**
 * Lo que la interfaz necesita: sin lógica de estados en el DOM.
 * @param {UploadState} state
 */
export function viewOf(state) {
  const busy = isBusy(state.phase);
  return {
    phase: state.phase,
    percent: Math.floor(state.fraction * 100),
    /** En «finalizing» no hay forma de saber cuánto falta: la barra no promete un porcentaje. */
    indeterminate: state.phase === "finalizing",
    busy,
    /** Con el archivo ya entregado («finalizing») el servidor lo está guardando: cancelar ya no garantiza nada. */
    canCancel: state.phase === "uploading",
    canRetry: state.phase === "cancelled" || (state.phase === "error" && state.error !== null && state.error.retryable),
  };
}
