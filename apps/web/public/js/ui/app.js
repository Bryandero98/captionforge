// Cableado de la interfaz de subida: eventos del DOM -> máquina de estados (domain/upload-state.js) -> DOM.
// Todo texto entra con textContent: ningún dato (nombre de archivo, mensaje del servidor) se interpreta como HTML.

import { getCapabilities } from "../api/capabilities.js";
import { ApiError } from "../api/errors.js";
import { getJob, getQuality, getQualityProfiles, proposeQualityFix, putSegments } from "../api/jobs.js";
import { followJob } from "../api/sse.js";
import { precheckFile, uploadVideo } from "../api/upload.js";
import { formatBytes, formatDuration } from "../domain/format.js";
import { MAX_FILES, addFiles, currentOf, emptyBatch, markCancelled, markDone, markError, markUploading, removeItem, summaryOf } from "../domain/batch.js";
import { trackingViewOf } from "../domain/job-state.js";
import { initialState, reduce, viewOf } from "../domain/upload-state.js";
import { createTranslator, detectLang, REVIEWED_LANGS } from "../i18n/index.js";
import { createAi } from "./ai.js";
import { createBurn } from "./burn.js";
import { createQuality } from "./quality.js";
import { createHistory } from "./history.js";
import { detailText, statusText } from "./job-text.js";
import { languageNames as languageNamesFor } from "./language-names.js";
import { createResults } from "./results.js";
import { createSpendConfirm } from "./spend-confirm.js";
import { createTracker } from "./tracker.js";

const LANG_KEY = "captionforge_lang";
/** Espera por defecto que se muestra en 429/503 si el servidor no manda Retry-After. */
const DEFAULT_RETRY_SECONDS = 10;
const MODELS = ["base", "small", "medium"];

/**
 * @param {{
 *   doc: Document,
 *   win: Window,
 *   config: { baseUrl: string, maxBytes: number },
 *   uploader?: typeof uploadVideo,
 *   follower?: typeof followJob,
 *   fetchJob?: typeof getJob,
 *   capabilities?: typeof getCapabilities,
 *   canLaunch?: boolean,
 *   byokAvailable?: boolean,
 *   onTranslate?: (t: (key: string, params?: Record<string, string | number>) => string) => void,
 * }} deps
 */
export function createApp({ doc, win, config, uploader = uploadVideo, follower = followJob, fetchJob = getJob, capabilities = getCapabilities, canLaunch = true, byokAvailable = true, onTranslate = () => {} }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    form: $("upload-form"),
    fields: $("form-fields"),
    drop: $("drop"),
    input: $("file-input"),
    formats: $("drop-formats"),
    langNotice: $("lang-notice"),
    problem: $("file-problem"),
    fileRow: $("file-row"),
    fileName: $("file-name"),
    fileSize: $("file-size"),
    fileRemove: $("file-remove"),
    batchList: $("batch-list"),
    model: $("opt-model"),
    source: $("opt-source"),
    translate: $("opt-translate"),
    clean: $("opt-clean"),
    diarize: $("opt-diarize"),
    diarizeHint: $("opt-diarize-hint"),
    start: $("start"),
    progress: $("progress-panel"),
    progressStatus: $("progress-status"),
    bar: $("bar"),
    barFill: $("bar-fill"),
    progressDetail: $("progress-detail"),
    cancel: $("cancel"),
    notice: $("notice-panel"),
    noticeText: $("notice-text"),
    noticeJob: $("notice-job"),
    noticeRetry: $("notice-retry"),
    noticeAgain: $("notice-again"),
    error: $("error-panel"),
    errorMessage: $("error-message"),
    errorDetail: $("error-detail"),
    errorRetry: $("error-retry"),
    errorOther: $("error-other"),
    jobPanel: $("job-panel"),
    jobStatus: $("job-status"),
    jobBar: $("job-bar"),
    jobBarFill: $("job-bar-fill"),
    jobDetail: $("job-detail"),
    jobReconnect: $("job-reconnect"),
    announcer: $("announcer"),
  };

  /** @type {string} */
  let lang = detectLang(readStored(win), win.navigator.languages);
  let t = createTranslator(lang);
  let state = initialState;
  // Cola de subida (domain/batch.js): los archivos elegidos, de uno en uno.
  let batch = emptyBatch;
  /** Archivos que no entraron en la cola, con su motivo. @type {{ name: string, problem: ApiError }[]} */
  let rejected = [];
  let overflow = 0;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {number | undefined} */
  let countdown;
  /** Espera impuesta por el servidor (429/503): fecha límite, error al que pertenece y si sigue vigente. */
  let retryUntil = 0;
  /** @type {ApiError | null} */
  let countdownFor = null;
  let waiting = false;
  let previousPhase = state.phase;
  let announcedStep = -1;
  // Seguimiento del trabajo por SSE (ui/tracker.js), independiente de la subida: sigue tras «en cola».
  const tracker = createTracker({ baseUrl: config.baseUrl, follower, onChange: () => renderJob() });
  let trackedKind = "none";
  let trackedStep = -1;
  /** @type {string | null} */
  let trackedStage = null;

  const translate = (/** @type {string} */ key, /** @type {Record<string, string | number> | undefined} */ params) => t(key, params);
  /** @type {ReturnType<typeof createBurn> | null} */
  let burn = null;
  /** @type {ReturnType<typeof createAi> | null} */
  let ai = null;
  /** @type {ReturnType<typeof createQuality> | null} */
  let quality = null;
  // Qué ofrece el servidor: lo usan la casilla de hablantes y los formularios de traducir y doblar.
  const found = capabilities({ baseUrl: config.baseUrl });
  const spend = createSpendConfirm({ doc, t: translate });
  const results = createResults({ doc, win, baseUrl: config.baseUrl, t: translate, lang: () => lang, announce: (text) => announce(text), onChange: () => {
    burn?.refreshForm();
    ai?.refreshForm();
    quality?.refreshForm();
  } });
  const history = createHistory({ doc, win, t: translate, lang: () => lang, onOpen: (entry) => void openJob(entry.id) });
  burn = createBurn({
    doc,
    win,
    baseUrl: config.baseUrl,
    t: translate,
    announce: (text) => announce(text),
    context: () => results.context,
    onStarted: (job, parentName) => history.add({ id: job.id, name: parentName, kind: "BURN", at: Date.now(), ...(typeof job.parentJobId === "string" ? { parentId: job.parentJobId } : {}) }),
    onOpenParent: (parentId) => void openJob(parentId),
    follower,
  });
  ai = createAi({
    doc,
    win,
    baseUrl: config.baseUrl,
    t: translate,
    lang: () => lang,
    announce: (text) => announce(text),
    context: () => results.context,
    canLaunch,
    // Las claves externas se guardan con una sesión de Dueño: sin sesión (modo local) nadie puede ponerlas, aunque el servidor tenga APP_SECRET.
    capabilities: () => found.then((all) => (byokAvailable ? all : { ...all, byok: { enabled: false, providers: [], allowPrivateBaseUrls: false } })),
    spend,
    follower,
    onStarted: (job, parentName, kind) => history.add({ id: job.id, name: parentName, kind, at: Date.now(), ...(typeof job.parentJobId === "string" ? { parentId: job.parentJobId } : {}) }),
    onOpenParent: (parentId) => void openJob(parentId),
  });

  // Calidad de los subtítulos (ADR 0021): el informe y el arreglo los calcula el API; aquí solo se piden y se pintan.
  quality = createQuality({
    doc,
    t: translate,
    lang: () => lang,
    announce: (text) => announce(text),
    context: () => results.context,
    canEdit: canLaunch,
    fetchProfiles: () => getQualityProfiles({ baseUrl: config.baseUrl }),
    fetchReport: ({ jobId, profile }) => getQuality({ baseUrl: config.baseUrl, jobId, profile }),
    fetchFix: ({ jobId, profile }) => proposeQualityFix({ baseUrl: config.baseUrl, jobId, profile }),
    applyEdits: ({ jobId, edits, etag }) => putSegments({ baseUrl: config.baseUrl, jobId, edits, etag }),
    onApplied: () => results.reload(),
  });

  // ---------- estado ----------

  /** @param {Parameters<typeof reduce>[1]} event */
  function dispatch(event) {
    state = reduce(state, event);
    render();
  }

  /**
   * Sube el archivo que toca de la cola. Si hay más pendientes, al aceptarse uno sigue con el siguiente; si uno falla o se
   * cancela, la cola se detiene ahí y «Reintentar» lo retoma.
   */
  async function begin() {
    const item = currentOf(batch);
    if (item === null || viewOf(state).busy || waiting) return;
    stopTracking();
    batch = markUploading(batch, item.key);
    const abort = new AbortController();
    controller = abort;
    dispatch({ type: "start", file: { name: item.file.name, size: item.file.size }, at: win.performance.now() });
    let accepted = false;
    try {
      const job = await uploader({
        file: /** @type {File} */ (item.file),
        options: { modelSize: els.model.value, sourceLanguage: els.source.value, translateTo: els.translate.value, cleanAudio: els.clean.checked, diarize: els.diarize.checked && !els.diarize.disabled },
        baseUrl: config.baseUrl,
        maxBytes: config.maxBytes,
        signal: abort.signal,
        onProgress: (event) =>
          event.phase === "uploading"
            ? dispatch({ type: "progress", loaded: event.loaded, total: event.total, at: win.performance.now() })
            : dispatch({ type: "sent" }),
      });
      batch = markDone(batch, item.key, job.id);
      dispatch({ type: "accepted", job });
      history.add({ id: job.id, name: item.file.name, kind: "TRANSCRIBE", at: Date.now() });
      void tracker.follow(job.id);
      accepted = true;
    } catch (error) {
      // Un fallo que no es del API (un bug) no debe pasar por «error de red» sin dejar rastro.
      if (!(error instanceof ApiError)) console.error(error);
      const failure = error instanceof ApiError ? error : ApiError.network();
      batch = failure.code === "aborted" ? markCancelled(batch, item.key) : markError(batch, item.key, failure);
      dispatch({ type: "failed", error: failure });
    } finally {
      if (controller === abort) controller = null;
    }
    if (accepted && summaryOf(batch).pending > 0) {
      const { done, total } = summaryOf(batch);
      announce(t("batch.progress", { done, total }));
      void begin(); // el siguiente de la cola
    }
  }

  /**
   * Abre un trabajo del historial: si sigue en curso se retoma el seguimiento; si terminó, se muestra su estado final
   * (y los subtítulos si es una transcripción completada). Un trabajo que el servidor ya no tiene se dice como tal.
   */
  async function openJob(/** @type {string} */ jobId) {
    if (viewOf(state).busy) return; // hay una subida en curso: no se pisa
    if (!confirmLeave()) return;
    if (state.phase !== "idle") state = initialState;
    render();
    burn?.stop();
    ai?.stop();
    const { job, replaced } = await tracker.open(jobId, fetchJob);
    if (replaced) return; // otra apertura lo reemplazó
    if (job?.kind === "BURN") {
      // Un quemado tiene su propio panel: el seguimiento principal no lo muestra.
      tracker.stop();
      burn?.adopt(job);
      doc.getElementById("burn-panel")?.focus();
      return;
    }
    if (job?.kind === "TRANSLATE" || job?.kind === "DUB") {
      // Traducir y doblar también tienen su propio panel (ui/ai.js).
      tracker.stop();
      ai?.adopt(job);
      doc.getElementById(job.kind === "DUB" ? "dub-panel" : "translate-panel")?.focus();
      return;
    }
    els.jobPanel.focus();
  }

  function stopTracking() {
    tracker.stop();
    burn?.stop();
    ai?.stop();
    trackedKind = "none";
    trackedStep = -1;
  }

  /** Con cambios sin guardar en los subtítulos, pregunta antes de abandonarlos. */
  function confirmLeave() {
    return !results.dirty || win.confirm(t("editor.leave"));
  }

  function startOver() {
    if (!confirmLeave()) return;
    stopTracking();
    clearFile();
    dispatch({ type: "reset" });
  }

  // ---------- archivo ----------

  /**
   * Añade archivos a la cola. Si la anterior ya terminó, empieza una nueva. Los que no sirven no entran y se explica por qué.
   * @param {ArrayLike<File> | null | undefined} chosen
   */
  function selectFiles(chosen) {
    const files = Array.from(chosen ?? []);
    if (files.length === 0 || viewOf(state).busy) return;
    const fresh = currentOf(batch) === null;
    const result = addFiles(fresh ? emptyBatch : batch, files, (candidate) => precheckFile(candidate, { maxBytes: config.maxBytes }));
    batch = result.batch;
    rejected = result.rejected;
    overflow = result.overflow;
    if (fresh && state.phase !== "idle") state = initialState; // archivos nuevos descartan el resultado anterior
    els.input.value = ""; // permite volver a elegir el mismo archivo
    render();
    if (batch.items.length > 1) announce(t("batch.added", { count: batch.items.length }));
  }

  function clearFile() {
    batch = emptyBatch;
    rejected = [];
    overflow = 0;
    els.input.value = "";
  }

  /** Qué se dice de los archivos que no entraron en la cola. */
  function rejectedText() {
    if (rejected.length === 0 && overflow === 0) return "";
    const parts = [];
    const first = rejected[0];
    if (rejected.length === 1 && first && overflow === 0 && batch.items.length === 0) return t(`error.${first.problem.code}`); // un solo archivo elegido y no sirve
    if (rejected.length > 0) {
      const shown = rejected.slice(0, 3).map((entry) => `${entry.name} (${t(`error.${entry.problem.code}`)})`);
      const more = rejected.length - shown.length;
      parts.push(t("batch.rejected", { count: rejected.length, list: shown.join("; ") + (more > 0 ? ` +${more}` : "") }));
    }
    if (overflow > 0) parts.push(t("batch.overflow", { max: MAX_FILES, count: overflow }));
    return parts.join(" ");
  }

  const STATUS_KEY = /** @type {const} */ ({ pending: "batch.status.pending", uploading: "batch.status.uploading", done: "batch.status.done", error: "batch.status.error", cancelled: "batch.status.cancelled" });

  /** Lo que se ve de la cola: si no cambia, la lista no se reconstruye (se perdería el foco con cada evento de progreso). */
  let batchSignature = "";

  /** La lista de la cola, solo cuando hay más de un archivo. */
  function renderBatch() {
    const many = batch.items.length > 1;
    els.batchList.hidden = !many;
    const signature = many ? `${lang}|${batch.items.map((item) => `${item.key}:${item.status}:${item.jobId ?? ""}:${item.file.name}:${item.file.size}`).join("|")}` : "";
    if (signature === batchSignature) return;
    batchSignature = signature;
    if (!many) {
      els.batchList.replaceChildren();
      return;
    }
    els.batchList.setAttribute("aria-label", t("batch.title"));
    els.batchList.replaceChildren(
      ...batch.items.map((item) => {
        const li = doc.createElement("li");
        li.className = "batch__item";
        li.dataset.status = item.status;
        const name = doc.createElement("span");
        name.className = "batch__name";
        name.textContent = item.file.name;
        const meta = doc.createElement("span");
        meta.className = "batch__meta";
        meta.textContent = `${formatBytes(item.file.size, lang)} · ${t(STATUS_KEY[item.status])}`;
        li.append(name, meta);
        if (item.status === "done" && item.jobId !== null) {
          const jobId = item.jobId;
          const open = doc.createElement("button");
          open.type = "button";
          open.className = "btn btn--ghost";
          open.textContent = t("history.open");
          open.setAttribute("aria-label", t("history.open.label", { name: item.file.name }));
          open.addEventListener("click", () => void openJob(jobId));
          li.append(open);
        } else if (item.status !== "uploading") {
          const remove = doc.createElement("button");
          remove.type = "button";
          remove.className = "btn btn--ghost";
          remove.textContent = t("history.remove");
          remove.setAttribute("aria-label", t("batch.remove.label", { name: item.file.name }));
          remove.addEventListener("click", () => {
            const index = batch.items.findIndex((candidate) => candidate.key === item.key);
            batch = removeItem(batch, item.key);
            render();
            // El foco pasa a la fila que ocupa ahora ese sitio (o a la última); sin lista, al selector de archivos.
            const buttons = els.batchList.querySelectorAll("li button");
            const next = /** @type {HTMLElement | undefined} */ (buttons[Math.min(index, buttons.length - 1)]);
            (next ?? els.input).focus();
            announce(t("batch.removed", { name: item.file.name }));
          });
          li.append(remove);
        }
        return li;
      }),
    );
  }

  // ---------- pintado ----------

  function render() {
    const view = viewOf(state);
    const locked = view.busy || state.phase === "queued";

    const current = currentOf(batch);
    const waitingCount = batch.items.filter((item) => item.status === "pending" || item.status === "error" || item.status === "cancelled").length;
    els.fields.disabled = locked;
    els.start.disabled = current === null || locked;
    els.start.textContent = waitingCount > 1 ? t("action.startMany", { count: waitingCount }) : t("action.start");
    els.fileRow.hidden = current === null || batch.items.length > 1;
    if (current !== null) {
      els.fileName.textContent = current.file.name;
      els.fileSize.textContent = formatBytes(current.file.size, lang);
    }
    const problem = rejectedText();
    els.problem.hidden = problem === "";
    // role="alert": reescribir el mismo texto en cada repintado lo haría anunciar de nuevo.
    if (els.problem.textContent !== problem) els.problem.textContent = problem;
    renderBatch();

    renderProgress(view);
    renderNotice(view);
    renderError(view);
    renderJob();
    history.setBusy(view.busy);
    manageFocusAndAnnouncements(view);
    previousPhase = state.phase;
  }

  /** @param {ReturnType<typeof viewOf>} view */
  function renderProgress(view) {
    els.progress.hidden = !view.busy;
    if (!view.busy) return;
    els.cancel.hidden = !view.canCancel;
    const status = state.phase === "finalizing" ? t("upload.finalizing") : t("upload.uploading", { percent: view.percent });
    els.progressStatus.textContent = status;
    els.bar.classList.toggle("is-indeterminate", view.indeterminate);
    if (view.indeterminate) {
      els.bar.removeAttribute("aria-valuenow");
      els.barFill.style.transform = "";
    } else {
      els.bar.setAttribute("aria-valuenow", String(view.percent));
      els.barFill.style.transform = `scaleX(${state.fraction})`;
    }
    els.bar.setAttribute("aria-valuetext", status);
    const parts = [t("upload.detail", { loaded: formatBytes(state.loaded, lang), total: formatBytes(state.total, lang) })];
    if (state.phase === "uploading" && state.bytesPerSecond > 0) {
      parts.push(t("upload.speed", { speed: formatBytes(state.bytesPerSecond, lang) }));
      const eta = formatDuration(state.etaSeconds);
      if (eta !== "") parts.push(t("upload.eta", { time: eta }));
    }
    const position = batch.items.length > 1 ? `${t("batch.position", { n: summaryOf(batch).done + 1, total: batch.items.length })} · ` : "";
    els.progressDetail.textContent = state.phase === "finalizing" ? position.replace(/ · $/, "") : position + parts.join(" · ");
  }

  function renderJob() {
    const view = trackingViewOf(tracker.state);
    // Un quemado tiene su propio panel (ui/burn.js): el principal solo muestra transcripciones.
    const jobKind = tracker.state.job?.kind;
    const hidden = view.kind === "none" || jobKind === "BURN" || jobKind === "TRANSLATE" || jobKind === "DUB";
    els.jobPanel.hidden = hidden;
    if (hidden) {
      results.hide();
      return;
    }
    els.jobPanel.classList.toggle("is-failed", view.kind === "failed");
    const trackedJob = tracker.state.job;
    if (view.kind === "completed" && trackedJob?.kind === "TRANSCRIBE") results.show(trackedJob);
    else results.hide();

    const status = statusText(view, t);
    els.jobStatus.textContent = status;

    const showBar = view.kind === "queued" || view.kind === "running" || view.kind === "completed";
    els.jobBar.hidden = !showBar;
    els.jobBar.classList.toggle("is-indeterminate", view.indeterminate);
    els.jobBar.classList.toggle("is-done", view.kind === "completed");
    if (view.indeterminate) {
      els.jobBar.removeAttribute("aria-valuenow");
      els.jobBarFill.style.transform = "";
    } else {
      els.jobBar.setAttribute("aria-valuenow", String(view.percent));
      els.jobBarFill.style.transform = `scaleX(${view.percent / 100})`;
    }
    els.jobBar.setAttribute("aria-valuetext", status);

    const detail = detailText(view, t);
    els.jobDetail.textContent = detail;
    els.jobDetail.hidden = detail === "";
    els.jobReconnect.hidden = !(view.kind === "lost" && view.error?.code !== "not_found");

    // Anuncios: cada cambio de estado o de etapa y los hitos de 25 %, nunca cada porcentaje.
    const kindChanged = view.kind !== trackedKind;
    if (kindChanged) {
      trackedKind = view.kind;
      trackedStep = -1;
      trackedStage = view.stage;
      announce(status);
      keepFocus(view);
    } else if (view.kind === "running" && view.stage !== trackedStage) {
      trackedStage = view.stage;
      trackedStep = -1;
      announce(status);
    }
    if (view.kind === "running" && !view.indeterminate) {
      const step = Math.floor(view.percent / 25);
      if (step > trackedStep && step > 0) {
        trackedStep = step;
        announce(status);
      }
    }
  }

  /**
   * Vaciar y reponer el texto en otro momento: un mensaje idéntico al anterior (otra pérdida de conexión) o dos seguidos
   * se leerían como uno solo, o ninguno.
   */
  function announce(/** @type {string} */ text) {
    els.announcer.textContent = "";
    win.setTimeout(() => {
      els.announcer.textContent = text;
    }, 50);
  }

  /** Si el elemento con el foco acaba de ocultarse (el botón usado), el foco no debe caer en el vacío. */
  function keepFocus(/** @type {ReturnType<typeof trackingViewOf>} */ view) {
    const active = doc.activeElement;
    const lostFocus = active === null || active === doc.body || active.closest("[hidden]") !== null;
    if (!lostFocus) return;
    if (view.kind === "lost" && !els.jobReconnect.hidden) els.jobReconnect.focus();
    else if (view.terminal || view.kind === "lost") els.jobPanel.focus();
  }

  /** @param {ReturnType<typeof viewOf>} view */
  function renderNotice(view) {
    const show = state.phase === "queued" || state.phase === "cancelled";
    els.notice.hidden = !show;
    if (!show) return;
    els.noticeText.textContent =
      state.phase === "queued" ? (summaryOf(batch).done > 1 ? t("batch.received", { count: summaryOf(batch).done }) : t("upload.queued")) : t("upload.cancelled");
    els.noticeJob.textContent = state.job ? t("upload.jobId", { id: state.job.id }) : "";
    els.noticeJob.hidden = state.job === null;
    els.noticeRetry.hidden = !view.canRetry;
  }

  /** @param {ReturnType<typeof viewOf>} view */
  function renderError(view) {
    const error = state.error;
    const show = state.phase === "error" && error !== null;
    els.error.hidden = !show;
    if (!show || error === null) {
      stopCountdown();
      return;
    }
    const seconds = error.retryAfter ?? DEFAULT_RETRY_SECONDS;
    els.errorMessage.textContent = t(`error.${error.code}`, { seconds: waiting ? secondsLeft() : seconds });
    els.errorDetail.hidden = error.detail === null;
    els.errorDetail.textContent = error.detail === null ? "" : t("error.detail", { detail: error.detail });
    els.errorRetry.hidden = !view.canRetry;
    // Con el servidor saturado se espera lo que pide antes de dejar reintentar. La espera se mide contra una fecha
    // límite: repintar (cambio de idioma) no la reinicia, y cada error nuevo arranca la suya.
    const mustWait = view.canRetry && (error.code === "rate_limited" || error.code === "busy");
    if (mustWait && countdownFor !== error) startCountdown(error, seconds);
    if (!mustWait) stopCountdown();
    paintRetry();
  }

  function secondsLeft() {
    return Math.max(0, Math.ceil((retryUntil - win.performance.now()) / 1000));
  }

  /** `aria-disabled` y no `disabled`: el botón conserva el foco durante la espera y el lector de pantalla lo sigue leyendo. */
  function paintRetry() {
    const left = waiting ? secondsLeft() : 0;
    els.errorRetry.setAttribute("aria-disabled", String(left > 0));
    els.errorRetry.textContent = left > 0 ? t("action.retryIn", { seconds: left }) : t("action.retry");
    if (waiting && left <= 0) {
      waiting = false;
      if (countdown !== undefined) win.clearInterval(countdown);
      countdown = undefined;
      if (state.phase === "error") els.announcer.textContent = t("action.retry");
    }
  }

  /**
   * @param {ApiError} error
   * @param {number} seconds
   */
  function startCountdown(error, seconds) {
    stopCountdown();
    countdownFor = error;
    retryUntil = win.performance.now() + seconds * 1000;
    waiting = true;
    countdown = win.setInterval(() => {
      els.errorMessage.textContent = t(`error.${error.code}`, { seconds: secondsLeft() });
      paintRetry();
    }, 1000);
  }

  function stopCountdown() {
    if (countdown !== undefined) win.clearInterval(countdown);
    countdown = undefined;
    waiting = false;
    countdownFor = null;
  }

  /** @param {ReturnType<typeof viewOf>} view */
  function manageFocusAndAnnouncements(view) {
    const changed = state.phase !== previousPhase;
    if (changed) {
      announcedStep = -1;
      // El botón que se acaba de usar se desactiva u oculta: el foco no debe caer en el vacío.
      if (state.phase === "uploading") els.cancel.focus();
      else if (state.phase === "finalizing") els.progress.focus(); // «Cancelar» se oculta: el foco no cae en el vacío
      else if (state.phase === "error") (view.canRetry ? els.errorRetry : els.errorOther).focus();
      else if (state.phase === "queued" || state.phase === "cancelled") els.noticeAgain.focus();
      else if (state.phase === "idle") els.input.focus();
      const messages = {
        finalizing: t("upload.finalizing"),
        queued: t("upload.queued"),
        cancelled: t("upload.cancelled"),
      };
      if (state.phase in messages) els.announcer.textContent = messages[/** @type {keyof typeof messages} */ (state.phase)];
      // El panel de error ya no es role="alert" (se releería cada segundo con la cuenta atrás): se anuncia una vez.
      if (state.phase === "error" && state.error !== null) els.announcer.textContent = els.errorMessage.textContent;
    }
    // Solo hitos de 25 %: anunciar cada porcentaje volvería inusable el lector de pantalla.
    if (state.phase === "uploading") {
      const step = Math.floor(view.percent / 25);
      if (step > announcedStep && step > 0) {
        announcedStep = step;
        els.announcer.textContent = t("upload.uploading", { percent: view.percent });
      }
    }
  }

  // ---------- textos e idioma ----------

  function translateStatic() {
    doc.documentElement.lang = lang;
    for (const element of doc.querySelectorAll("[data-i18n]")) element.textContent = t(element.getAttribute("data-i18n") ?? "");
    for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", t(element.getAttribute("data-i18n-aria-label") ?? ""));
    doc.title = t("app.title");
    els.formats.textContent = t("drop.formats", { max: formatBytes(config.maxBytes, lang) });
    for (const button of doc.querySelectorAll("[data-lang]")) button.setAttribute("aria-pressed", String(button.getAttribute("data-lang") === lang));
    // Solo el español y el inglés están revisados por personas: en el resto se avisa de que es traducción automática.
    // Región viva que solo cambia de contenido (ocultarla con `hidden` hace poco fiable el anuncio).
    els.langNotice.textContent = REVIEWED_LANGS.includes(lang) ? "" : t("lang.notice");
    fillSelects();
    onTranslate(t); // la cuenta (ui/account.js) repinta lo que depende de los datos
  }

  const languageNames = () => languageNamesFor(lang);

  /** Reconstruye los <select> conservando lo elegido. */
  function fillSelects() {
    const keep = { model: els.model.value || "small", source: els.source.value, translate: els.translate.value };
    const build = (/** @type {HTMLSelectElement} */ select, /** @type {{ value: string, label: string }[]} */ options, /** @type {string} */ value) => {
      select.replaceChildren(...options.map(({ value: v, label }) => Object.assign(doc.createElement("option"), { value: v, textContent: label })));
      select.value = value;
      if (select.value !== value) select.selectedIndex = 0;
    };
    const names = languageNames();
    build(els.model, MODELS.map((m) => ({ value: m, label: t(`options.model.${m}`) })), keep.model);
    build(els.source, [{ value: "", label: t("options.source.auto") }, ...names.map(({ code, label }) => ({ value: code, label }))], keep.source);
    build(els.translate, [{ value: "", label: t("options.translate.none") }, ...names.map(({ code, label }) => ({ value: code, label }))], keep.translate);
  }

  /** @param {string} next */
  function setLang(next) {
    lang = next;
    t = createTranslator(lang);
    try {
      win.localStorage.setItem(LANG_KEY, lang);
    } catch {
      // sin almacenamiento: la preferencia dura solo esta visita
    }
    results.refresh();
    history.refresh();
    burn?.refresh();
    spend.refresh(translate);
    ai?.refresh();
    quality?.refresh(translate);
    translateStatic(); // la espera de un 429 sigue su curso: renderError repinta con el tiempo que queda
    render();
  }

  // ---------- eventos ----------

  els.input.addEventListener("change", () => selectFiles(els.input.files));
  els.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void begin();
  });
  els.cancel.addEventListener("click", () => controller?.abort());
  els.errorRetry.addEventListener("click", () => void begin());
  els.noticeRetry.addEventListener("click", () => void begin());
  els.jobReconnect.addEventListener("click", () => {
    if (tracker.state.jobId !== null) void tracker.follow(tracker.state.jobId);
  });
  els.errorOther.addEventListener("click", startOver);
  els.noticeAgain.addEventListener("click", startOver);
  els.fileRemove.addEventListener("click", () => {
    if (viewOf(state).busy) return;
    const current = currentOf(batch);
    if (current !== null) batch = removeItem(batch, current.key);
    rejected = [];
    overflow = 0;
    els.input.value = "";
    if (currentOf(batch) === null) state = initialState;
    render();
    els.input.focus();
  });
  for (const button of doc.querySelectorAll("[data-lang]")) button.addEventListener("click", () => setLang(button.getAttribute("data-lang") ?? "es"));

  // Arrastrar y soltar. Fuera de la zona se cancela el comportamiento por defecto: si no, soltar un video junto a la
  // zona haría que el navegador lo abra y se pierda la página.
  for (const name of /** @type {const} */ (["dragover", "drop"])) win.addEventListener(name, (event) => event.preventDefault());
  els.drop.addEventListener("dragover", () => {
    if (!els.fields.disabled) els.drop.classList.add("is-over");
  });
  for (const name of ["dragleave", "dragend"]) els.drop.addEventListener(name, () => els.drop.classList.remove("is-over"));
  els.drop.addEventListener("drop", (/** @type {Event} */ event) => {
    els.drop.classList.remove("is-over");
    if (!els.fields.disabled) selectFiles(/** @type {DragEvent} */ (event).dataTransfer?.files);
  });

  // Salir de la página corta la subida: se avisa solo mientras hay una en curso.
  win.addEventListener("beforeunload", (/** @type {BeforeUnloadEvent} */ event) => {
    if (!viewOf(state).busy && !results.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  /** Identificar hablantes solo se ofrece si el servidor lo tiene (token de Hugging Face); si no, la casilla queda apagada y se explica. */
  function applyCapabilities(/** @type {import("../api/capabilities.js").Capabilities} */ found) {
    const enabled = found.diarization.enabled;
    els.diarize.disabled = !enabled;
    if (!enabled) els.diarize.checked = false;
    els.diarizeHint.hidden = enabled;
  }

  translateStatic();
  render();
  void found.then(applyCapabilities);

  return { get state() { return state; }, dispatch, setLang };
}

/** @param {Window} win */
function readStored(win) {
  try {
    return win.localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}
