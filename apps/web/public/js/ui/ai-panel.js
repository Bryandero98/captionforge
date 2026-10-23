// Panel de seguimiento de un trabajo de IA (traducir o doblar): estado, barra, cancelar, reconectar y «abrir los subtítulos».
// Es un trabajo aparte, con su propio seguimiento SSE (ui/tracker.js), como el quemado. Lo que se muestra al terminar
// (descargas, avisos) lo pinta quien lo usa con `onChange`. Los ids salen del prefijo: `translate-panel`, `dub-status`...

import { ApiError } from "../api/errors.js";
import { cancelJob } from "../api/jobs.js";
import { followJob } from "../api/sse.js";
import { trackingViewOf } from "../domain/job-state.js";
import { detailText, statusText } from "./job-text.js";
import { createTracker } from "./tracker.js";

/** Fallos cuyo texto ya está en el idioma de la interfaz: el mensaje del servidor (en español) sobraría. */
const TRANSLATED_FAILURES = /^(EXTERNAL_|JOB_TOO_LARGE$)/;

/**
 * @param {{
 *   doc: Document, prefix: string, baseUrl: string,
 *   t: () => (key: string, params?: Record<string, string | number>) => string,
 *   announce: (text: string) => void,
 *   onOpenParent: (parentId: string) => void,
 *   onChange: () => void,
 *   follower?: typeof followJob, cancel?: typeof cancelJob,
 * }} deps `t` es una función que devuelve el traductor vigente (cambia con el idioma)
 */
export function createAiPanel({ doc, prefix, baseUrl, t: currentT, announce, onOpenParent, onChange, follower = followJob, cancel = cancelJob }) {
  /** @type {(name: string) => any} */
  const $ = (name) => {
    const element = doc.getElementById(`${prefix}-${name}`);
    if (!element) throw new Error(`Falta el elemento #${prefix}-${name}`);
    return element;
  };
  const els = { panel: $("panel"), status: $("status"), bar: $("bar"), barFill: $("bar-fill"), detail: $("detail"), cancel: $("cancel"), reconnect: $("reconnect"), parent: $("open-parent") };

  const tracker = createTracker({ baseUrl, follower, onChange: () => render() });
  let lastKind = "none";
  /** Sube con cada `stop()`: una cancelación que vuelve después de parar no resucita el panel. */
  let epoch = 0;

  /** Hay un trabajo vivo. Con la conexión perdida (que no sea un 404) puede seguir en el servidor: se cuenta como vivo. */
  const busy = () => {
    const view = trackingViewOf(tracker.state);
    if (tracker.state.jobId === null || view.terminal) return false;
    return view.kind !== "lost" || view.error?.code !== "not_found";
  };

  function render() {
    const t = currentT();
    const view = trackingViewOf(tracker.state);
    els.panel.hidden = view.kind === "none";
    if (view.kind === "none") {
      onChange();
      return;
    }
    const status = statusText(view, t, { queued: t(`${prefix}.queued`), completed: t(`${prefix}.completed`) });
    els.status.textContent = status;
    const showBar = view.kind === "queued" || view.kind === "running" || view.kind === "completed";
    els.bar.hidden = !showBar;
    els.bar.classList.toggle("is-indeterminate", view.indeterminate);
    els.bar.classList.toggle("is-done", view.kind === "completed");
    if (view.indeterminate) {
      els.bar.removeAttribute("aria-valuenow");
      els.barFill.style.transform = "";
    } else {
      els.bar.setAttribute("aria-valuenow", String(view.percent));
      els.barFill.style.transform = `scaleX(${view.percent / 100})`;
    }
    els.bar.setAttribute("aria-valuetext", status);
    const translatedFailure = view.failure !== null && TRANSLATED_FAILURES.test(view.failure.code);
    els.detail.textContent = translatedFailure ? "" : detailText(view, t);
    els.detail.hidden = els.detail.textContent === "";
    els.panel.classList.toggle("is-failed", view.kind === "failed");
    els.cancel.hidden = !(view.kind === "queued" || view.kind === "running");
    els.reconnect.hidden = !(view.kind === "lost" && view.error?.code !== "not_found");
    const parentId = tracker.state.job?.parentJobId;
    els.parent.hidden = !(typeof parentId === "string");
    els.parent.textContent = t("ai.openParent");
    if (view.kind !== lastKind) {
      lastKind = view.kind;
      if (view.terminal || view.kind === "lost") announce(status);
    }
    onChange();
  }

  els.cancel.addEventListener("click", async () => {
    const id = tracker.state.jobId;
    if (id === null) return;
    const mine = epoch;
    els.cancel.disabled = true;
    try {
      const job = await cancel({ baseUrl, jobId: id });
      // Si el flujo de eventos está reconectando, el estado nuevo no llegaría: se aplica el que devolvió el servidor.
      if (mine === epoch && tracker.state.jobId === id) tracker.dispatch({ type: "job", job });
    } catch (error) {
      if (mine !== epoch || tracker.state.jobId !== id) return;
      if (!(error instanceof ApiError)) console.error(error);
      els.detail.hidden = false;
      els.detail.textContent = currentT()(`error.${error instanceof ApiError ? error.code : "network"}`, { seconds: 10 });
      announce(els.detail.textContent);
    } finally {
      els.cancel.disabled = false;
    }
  });
  els.reconnect.addEventListener("click", () => {
    if (tracker.state.jobId !== null) void tracker.follow(tracker.state.jobId);
  });
  els.parent.addEventListener("click", () => {
    const parentId = tracker.state.job?.parentJobId;
    if (typeof parentId === "string") onOpenParent(parentId);
  });

  return {
    render,
    busy,
    /** @param {string} jobId */
    follow: (jobId) => tracker.follow(jobId),
    focus: () => els.panel.focus(),
    get state() {
      return tracker.state;
    },
    get view() {
      return trackingViewOf(tracker.state);
    },
    /** Muestra un trabajo ya existente (abierto desde el historial) y lo sigue si sigue en curso. @param {import("../api/sse.js").JobView} job */
    adopt(job) {
      tracker.dispatch({ type: "track", jobId: job.id });
      tracker.dispatch({ type: "job", job });
      if (!(job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED")) void tracker.follow(job.id);
    },
    /** Deja de seguir y oculta el panel. */
    stop() {
      epoch++;
      tracker.stop();
    },
  };
}
