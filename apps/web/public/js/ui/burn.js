// Quemado de subtítulos: formulario (estilo y karaoke) dentro del panel de resultados y panel propio del trabajo de
// quemado, que es un trabajo aparte con su propio seguimiento SSE (ui/tracker.js). Al terminar muestra el video
// (con Range, el navegador salta sin bajarlo entero) y su descarga.

import { PREVIEW_MAX_BYTES, fetchArtifact, saveBlobAs } from "../api/download.js";
import { ApiError } from "../api/errors.js";
import { cancelJob, startBurn } from "../api/jobs.js";
import { followJob } from "../api/sse.js";
import { trackingViewOf } from "../domain/job-state.js";
import { detailText, statusText } from "./job-text.js";
import { downloadName } from "./results.js";
import { createTracker } from "./tracker.js";

export const BURN_STYLES = /** @type {const} */ (["modern", "tiktok", "youtube", "minimal"]);

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   announce: (text: string) => void,
 *   context: () => { job: import("../api/sse.js").JobView, hasWords: boolean, dirty: boolean } | null,
 *   onStarted: (job: import("../api/sse.js").JobView, parentName: string) => void,
 *   onOpenParent: (parentId: string) => void,
 *   follower?: typeof followJob, start?: typeof startBurn, cancel?: typeof cancelJob,
 * }} deps
 */
export function createBurn({ doc, win, baseUrl, t, announce, context, onStarted, onOpenParent, follower = followJob, start = startBurn, cancel = cancelJob }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    form: $("burn-form"),
    style: $("burn-style"),
    karaoke: $("burn-karaoke"),
    hint: $("burn-hint"),
    submit: $("burn-start"),
    panel: $("burn-panel"),
    status: $("burn-status"),
    bar: $("burn-bar"),
    barFill: $("burn-bar-fill"),
    detail: $("burn-detail"),
    video: $("burn-video"),
    download: $("burn-download"),
    cancel: $("burn-cancel"),
    parent: $("burn-open-parent"),
    reconnect: $("burn-reconnect"),
  };

  const tracker = createTracker({ baseUrl, follower, onChange: () => renderPanel() });
  /** Mensaje del último intento de crear el quemado (409, red...). @type {string | null} */
  let startProblem = null;
  let starting = false;
  let lastKind = "none";
  /** Sube con cada `stop()`: un envío o una cancelación que vuelve después de parar no resucita el panel. */
  let epoch = 0;
  /** @type {string | null} */
  let shownVideoFor = null;
  /** El video se pide con la clave de API (un <video src> no puede mandarla) y se muestra desde un Blob. */
  /** @type {AbortController | null} */
  let videoLoad = null;
  /** @type {string | null} */
  let videoObjectUrl = null;
  /** @type {Blob | null} */
  let videoBlob = null;

  function fillStyles() {
    const keep = els.style.value || "modern";
    els.style.replaceChildren(
      ...BURN_STYLES.map((style) => Object.assign(doc.createElement("option"), { value: style, textContent: t(`burn.style.${style}`) })),
    );
    els.style.value = keep;
  }

  /** Hay un quemado vivo. Con la conexión perdida (que no sea un 404) puede seguir en el servidor: se cuenta como vivo. */
  const burning = () => {
    const view = trackingViewOf(tracker.state);
    if (tracker.state.jobId === null || view.terminal) return false;
    return view.kind !== "lost" || view.error?.code !== "not_found";
  };

  /** Suelta el video: sin esto sigue sonando y con la conexión abierta aunque el panel esté oculto. */
  function clearVideo() {
    videoLoad?.abort();
    videoLoad = null;
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.load();
    if (videoObjectUrl !== null) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = null;
    videoBlob = null;
    shownVideoFor = null;
  }

  /** Baja el video con la clave. Si es demasiado grande para la memoria de la página, no se previsualiza (sí se descarga). */
  async function loadVideo(/** @type {string} */ id) {
    const abort = new AbortController();
    videoLoad = abort;
    try {
      const response = await fetchArtifact({ baseUrl, jobId: id, name: "video", signal: abort.signal });
      const size = Number(response.headers.get("content-length"));
      if (Number.isFinite(size) && size > PREVIEW_MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        els.video.hidden = true;
        return;
      }
      const blob = await response.blob();
      if (abort.signal.aborted || shownVideoFor !== id) return;
      videoBlob = blob;
      videoObjectUrl = URL.createObjectURL(blob);
      els.video.src = videoObjectUrl;
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!(error instanceof ApiError)) console.error(error);
      els.video.hidden = true; // la descarga sigue disponible: si el fallo es de verdad, ahí se verá el error
    } finally {
      if (videoLoad === abort) videoLoad = null;
    }
  }

  /** «Descargar video»: con la clave de API, desde el Blob ya cargado o pidiéndolo de nuevo. */
  async function downloadVideo() {
    const id = tracker.state.jobId;
    if (id === null) return;
    try {
      const blob = videoBlob ?? (await (await fetchArtifact({ baseUrl, jobId: id, name: "video" })).blob());
      const original = tracker.state.job?.originalFilename;
      saveBlobAs({ doc, win, blob, filename: downloadName(typeof original === "string" ? original : "", "captioned.mp4") });
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      const code = error instanceof ApiError ? error.code : "network";
      startProblem = t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
      announce(startProblem);
      refreshForm();
    }
  }
  els.download.addEventListener("click", (/** @type {Event} */ event) => {
    event.preventDefault();
    void downloadVideo();
  });

  /** El formulario solo aparece con una transcripción abierta, y solo se puede enviar con los cambios guardados. */
  function refreshForm() {
    const ctx = context();
    els.form.hidden = ctx === null;
    if (ctx === null) return;
    els.karaoke.disabled = !ctx.hasWords;
    if (!ctx.hasWords) els.karaoke.checked = false;
    const blocked = ctx.dirty ? t("burn.hint.dirty") : burning() ? t("burn.hint.busy") : startProblem;
    els.hint.textContent = blocked ?? (ctx.hasWords ? "" : t("burn.hint.nowords"));
    els.hint.hidden = els.hint.textContent === "";
    els.submit.disabled = ctx.dirty || burning() || starting;
  }

  function renderPanel() {
    const view = trackingViewOf(tracker.state);
    els.panel.hidden = view.kind === "none";
    if (view.kind === "none") {
      clearVideo();
      refreshForm();
      return;
    }
    const status = statusText(view, t, { queued: t("burn.queued"), completed: t("burn.completed") });
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
    els.detail.textContent = detailText(view, t);
    els.detail.hidden = els.detail.textContent === "";
    els.panel.classList.toggle("is-failed", view.kind === "failed");
    els.cancel.hidden = !(view.kind === "queued" || view.kind === "running");
    els.reconnect.hidden = !(view.kind === "lost" && view.error?.code !== "not_found");

    const id = tracker.state.jobId;
    const done = view.kind === "completed" && id !== null;
    els.download.hidden = !done;
    els.video.hidden = !done;
    if (!done) {
      if (shownVideoFor !== null) clearVideo();
    } else if (shownVideoFor !== id) {
      shownVideoFor = id;
      void loadVideo(id);
    }
    const parentId = tracker.state.job?.parentJobId;
    els.parent.hidden = !(typeof parentId === "string" && context()?.job.id !== parentId);

    if (view.kind !== lastKind) {
      lastKind = view.kind;
      if (view.terminal || view.kind === "lost") announce(status);
    }
    refreshForm();
  }

  async function submit() {
    const ctx = context();
    if (ctx === null || ctx.dirty || burning() || starting) return;
    const mine = epoch;
    const parentName = String(ctx.job.originalFilename ?? ctx.job.id);
    starting = true;
    startProblem = null;
    refreshForm();
    /** @type {import("../api/sse.js").JobView | null} */
    let job = null;
    try {
      job = await start({ baseUrl, jobId: ctx.job.id, style: els.style.value, karaoke: els.karaoke.checked && !els.karaoke.disabled });
    } catch (error) {
      if (mine !== epoch) return;
      if (!(error instanceof ApiError)) console.error(error);
      const code = error instanceof ApiError ? error.code : "network";
      startProblem = code === "conflict" ? t("burn.error.conflict") : t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
      announce(startProblem);
    }
    if (mine === epoch) starting = false;
    if (job !== null) {
      // El quemado existe en el servidor aunque se haya cambiado de pantalla: queda en «Recientes» pase lo que pase.
      try {
        onStarted(job, parentName);
        if (mine === epoch) {
          void tracker.follow(job.id);
          els.panel.focus();
        }
      } catch (error) {
        console.error(error);
      }
    }
    if (mine === epoch) {
      refreshForm();
      // El botón se desactivó mientras tenía el foco: si el envío falló, el foco vuelve a él.
      if (job === null && doc.activeElement === doc.body) els.submit.focus();
    }
  }

  els.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void submit();
  });
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
      if (mine !== epoch || tracker.state.jobId !== id) return; // ya era otro quemado o se cerró el panel
      if (!(error instanceof ApiError)) console.error(error);
      els.detail.hidden = false;
      els.detail.textContent = t(`error.${error instanceof ApiError ? error.code : "network"}`, { seconds: 10 });
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

  // Un artefacto caducado, o una API de otro origen que media-src 'self' bloquea, dejaría un reproductor negro sin explicación.
  els.video.addEventListener("error", () => {
    if (els.video.hidden || els.video.getAttribute("src") === null) return;
    els.detail.hidden = false;
    els.detail.textContent = t("burn.video.error");
    announce(els.detail.textContent);
  });

  fillStyles();
  renderPanel();

  return {
    refreshForm,
    /** Repinta los textos que dependen del idioma. */
    refresh() {
      fillStyles();
      renderPanel();
    },
    /** Muestra un quemado ya existente (abierto desde el historial) y lo sigue si sigue en curso. @param {import("../api/sse.js").JobView} job */
    adopt(job) {
      tracker.dispatch({ type: "track", jobId: job.id });
      tracker.dispatch({ type: "job", job });
      if (!(job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED")) void tracker.follow(job.id);
    },
    /** Deja de seguir y oculta el panel. */
    stop() {
      epoch++;
      starting = false;
      startProblem = null;
      tracker.stop();
    },
  };
}
