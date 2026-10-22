// Cableado de la interfaz de subida: eventos del DOM -> máquina de estados (domain/upload-state.js) -> DOM.
// Todo texto entra con textContent: ningún dato (nombre de archivo, mensaje del servidor) se interpreta como HTML.

import { ApiError } from "../api/errors.js";
import { precheckFile, uploadVideo } from "../api/upload.js";
import { formatBytes, formatDuration } from "../domain/format.js";
import { LANGUAGES } from "../domain/languages.js";
import { initialState, reduce, viewOf } from "../domain/upload-state.js";
import { createTranslator, detectLang } from "../i18n/index.js";

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
 * }} deps
 */
export function createApp({ doc, win, config, uploader = uploadVideo }) {
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
    problem: $("file-problem"),
    fileRow: $("file-row"),
    fileName: $("file-name"),
    fileSize: $("file-size"),
    fileRemove: $("file-remove"),
    model: $("opt-model"),
    source: $("opt-source"),
    translate: $("opt-translate"),
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
    announcer: $("announcer"),
  };

  /** @type {string} */
  let lang = detectLang(readStored(win), win.navigator.languages);
  let t = createTranslator(lang);
  let state = initialState;
  /** @type {File | null} */
  let file = null;
  /** @type {ApiError | null} */
  let fileProblem = null;
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

  // ---------- estado ----------

  /** @param {Parameters<typeof reduce>[1]} event */
  function dispatch(event) {
    state = reduce(state, event);
    render();
  }

  async function begin() {
    if (file === null || fileProblem !== null || viewOf(state).busy || waiting) return;
    const abort = new AbortController();
    controller = abort;
    dispatch({ type: "start", file: { name: file.name, size: file.size }, at: win.performance.now() });
    try {
      const job = await uploader({
        file,
        options: { modelSize: els.model.value, sourceLanguage: els.source.value, translateTo: els.translate.value },
        baseUrl: config.baseUrl,
        maxBytes: config.maxBytes,
        signal: abort.signal,
        onProgress: (event) =>
          event.phase === "uploading"
            ? dispatch({ type: "progress", loaded: event.loaded, total: event.total, at: win.performance.now() })
            : dispatch({ type: "sent" }),
      });
      dispatch({ type: "accepted", job });
    } catch (error) {
      // Un fallo que no es del API (un bug) no debe pasar por «error de red» sin dejar rastro.
      if (!(error instanceof ApiError)) console.error(error);
      dispatch({ type: "failed", error: error instanceof ApiError ? error : ApiError.network() });
    } finally {
      if (controller === abort) controller = null;
    }
  }

  function startOver() {
    clearFile();
    dispatch({ type: "reset" });
  }

  // ---------- archivo ----------

  /** @param {File | undefined} chosen */
  function selectFile(chosen) {
    if (!chosen || viewOf(state).busy) return;
    file = chosen;
    fileProblem = precheckFile(chosen, { maxBytes: config.maxBytes });
    if (state.phase !== "idle") state = initialState; // un archivo nuevo descarta el resultado anterior
    render();
  }

  function clearFile() {
    file = null;
    fileProblem = null;
    els.input.value = "";
  }

  // ---------- pintado ----------

  function render() {
    const view = viewOf(state);
    const locked = view.busy || state.phase === "queued";

    els.fields.disabled = locked;
    els.start.disabled = file === null || fileProblem !== null || locked;
    els.fileRow.hidden = file === null;
    if (file !== null) {
      els.fileName.textContent = file.name;
      els.fileSize.textContent = formatBytes(file.size, lang);
    }
    els.problem.hidden = fileProblem === null;
    els.problem.textContent = fileProblem === null ? "" : t(`error.${fileProblem.code}`);

    renderProgress(view);
    renderNotice(view);
    renderError(view);
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
    els.progressDetail.textContent = state.phase === "finalizing" ? "" : parts.join(" · ");
  }

  /** @param {ReturnType<typeof viewOf>} view */
  function renderNotice(view) {
    const show = state.phase === "queued" || state.phase === "cancelled";
    els.notice.hidden = !show;
    if (!show) return;
    els.noticeText.textContent = state.phase === "queued" ? t("upload.queued") : t("upload.cancelled");
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
    fillSelects();
  }

  /** Nombre del idioma en el idioma de la interfaz; si el navegador no lo conoce, el nombre del diccionario. */
  function languageNames() {
    let names = null;
    try {
      names = new Intl.DisplayNames([lang], { type: "language" });
    } catch {
      // sin soporte: nombres en inglés
    }
    return LANGUAGES.map(({ code, name }) => {
      let label = name;
      try {
        label = names?.of(code) ?? name;
      } catch {
        // código que Intl no conoce
      }
      return { code, label: label.charAt(0).toLocaleUpperCase(lang) + label.slice(1) };
    }).sort((a, b) => a.label.localeCompare(b.label, lang));
  }

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
    translateStatic(); // la espera de un 429 sigue su curso: renderError repinta con el tiempo que queda
    render();
  }

  // ---------- eventos ----------

  els.input.addEventListener("change", () => selectFile(els.input.files?.[0]));
  els.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void begin();
  });
  els.cancel.addEventListener("click", () => controller?.abort());
  els.errorRetry.addEventListener("click", () => void begin());
  els.noticeRetry.addEventListener("click", () => void begin());
  els.errorOther.addEventListener("click", startOver);
  els.noticeAgain.addEventListener("click", startOver);
  els.fileRemove.addEventListener("click", () => {
    if (viewOf(state).busy) return;
    clearFile();
    state = initialState;
    render();
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
    if (!els.fields.disabled) selectFile(/** @type {DragEvent} */ (event).dataTransfer?.files?.[0]);
  });

  // Salir de la página corta la subida: se avisa solo mientras hay una en curso.
  win.addEventListener("beforeunload", (/** @type {BeforeUnloadEvent} */ event) => {
    if (!viewOf(state).busy) return;
    event.preventDefault();
    event.returnValue = "";
  });

  translateStatic();
  render();

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
