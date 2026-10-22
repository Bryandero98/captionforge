// Panel de resultados de una transcripción terminada: datos del trabajo, descargas (.srt del servidor, .vtt armado aquí)
// y la lista de subtítulos. Todo texto entra con textContent. Los subtítulos se pintan por tandas: un video largo puede
// tener miles y crear todos los nodos de golpe congelaría la página.

import { ApiError } from "../api/errors.js";
import { artifactUrl, getSegments } from "../api/jobs.js";
import { formatDuration } from "../domain/format.js";
import { formatTimestamp, segmentsToVtt } from "../domain/subtitles.js";

const CHUNK = 100;

/** @typedef {import("../api/jobs.js").Segment} Segment */

/**
 * Nombre de archivo para una descarga hecha en el cliente: el del video sin extensión y sin caracteres de ruta.
 * @param {string} originalFilename
 * @param {string} extension
 */
export function downloadName(originalFilename, extension) {
  const stem = Array.from(
    originalFilename
      .replace(/\.[A-Za-z0-9]{1,10}$/, "")
      // Rutas, controles y marcas de direccion/formato Unicode (un U+202E invertiria la extension en el explorador).
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, ""),
  )
    .slice(0, 120) // por puntos de codigo: no parte un par sustituto
    .join("");
  // Nombres reservados de Windows (CON, NUL, COM1...) no son un nombre de archivo valido.
  const safe = stem === "" ? "captionforge" : /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `_${stem}` : stem;
  return `${safe}.${extension}`;
}

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string, t: (key: string, params?: Record<string, string | number>) => string,
 *   lang: () => string, fetchSegments?: typeof getSegments,
 * }} deps
 */
export function createResults({ doc, win, baseUrl, t, lang, fetchSegments = getSegments }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    panel: $("result-panel"),
    language: $("result-language"),
    duration: $("result-duration"),
    count: $("result-count"),
    srt: $("dl-srt"),
    vtt: $("dl-vtt"),
    status: $("result-status"),
    retry: $("result-retry"),
    list: $("result-segments"),
    more: $("result-more"),
  };

  /** @type {import("../api/sse.js").JobView | null} */
  let job = null;
  /** @type {Segment[]} */
  let segments = [];
  let shown = 0;
  /** @type {ApiError | null} */
  let failure = null;
  let loading = false;
  /** @type {AbortController | null} */
  let controller = null;

  /** Nombre del idioma en el idioma de la interfaz; si Intl no lo conoce, el código tal cual. */
  function languageName(/** @type {string} */ code) {
    try {
      return new Intl.DisplayNames([lang()], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  function renderStatus() {
    if (loading) els.status.textContent = t("result.loading");
    else if (failure !== null) els.status.textContent = failure.code === "not_found" || failure.code === "conflict" ? t("result.expired") : t(`error.${failure.code}`, { seconds: failure.retryAfter ?? 10 });
    else els.status.textContent = "";
    els.status.hidden = els.status.textContent === "";
    els.retry.hidden = !(failure !== null && failure.code !== "not_found" && failure.code !== "conflict");
  }

  function renderFacts() {
    const result = /** @type {{ detectedLanguage?: string, durationSeconds?: number, segmentCount?: number } | null} */ (job?.result ?? null);
    els.language.textContent = result?.detectedLanguage ? languageName(result.detectedLanguage) : "—";
    els.duration.textContent = typeof result?.durationSeconds === "number" ? formatDuration(result.durationSeconds) || "—" : "—";
    els.count.textContent = typeof result?.segmentCount === "number" ? String(result.segmentCount) : "—";
  }

  function renderList() {
    const fragment = doc.createDocumentFragment();
    for (let i = shown; i < Math.min(segments.length, shown + CHUNK); i++) {
      const segment = /** @type {Segment} */ (segments[i]);
      const row = doc.createElement("li");
      row.className = "seg";
      const time = doc.createElement("time");
      time.className = "seg__time";
      time.textContent = formatTimestamp(segment.start, ".").slice(0, 8);
      const text = doc.createElement("span");
      text.className = "seg__text";
      text.textContent = segment.text;
      row.append(time, text);
      fragment.append(row);
    }
    shown = Math.min(segments.length, shown + CHUNK);
    els.list.append(fragment);
    const remaining = segments.length - shown;
    els.more.hidden = remaining <= 0;
    els.more.textContent = t("result.more", { count: remaining });
  }

  function renderStatic() {
    renderFacts();
    renderStatus();
    els.vtt.disabled = segments.length === 0;
    els.more.textContent = t("result.more", { count: Math.max(0, segments.length - shown) });
  }

  async function load() {
    if (job === null) return;
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    loading = true;
    failure = null;
    renderStatus();
    try {
      const data = await fetchSegments({ baseUrl, jobId: job.id, signal: abort.signal });
      if (abort.signal.aborted) return;
      segments = data.segments;
      els.list.replaceChildren();
      shown = 0;
      renderList();
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!(error instanceof ApiError)) console.error(error);
      failure = error instanceof ApiError ? error : ApiError.network();
    } finally {
      if (controller === abort) {
        loading = false;
        controller = null;
        renderStatic();
      }
    }
  }

  /** Descarga el .vtt armado con los subtítulos que se están viendo. */
  function downloadVtt() {
    if (job === null || segments.length === 0) return;
    const url = URL.createObjectURL(new Blob([segmentsToVtt(segments)], { type: "text/vtt" }));
    const link = doc.createElement("a");
    link.href = url;
    link.download = downloadName(typeof job.originalFilename === "string" ? job.originalFilename : "", "vtt");
    doc.body.append(link);
    link.click();
    link.remove();
    win.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  els.vtt.addEventListener("click", downloadVtt);
  els.retry.addEventListener("click", () => void load());
  els.more.addEventListener("click", renderList);

  return {
    /** Muestra el resultado de una transcripción terminada y carga sus subtítulos. @param {import("../api/sse.js").JobView} next */
    show(next) {
      if (job?.id === next.id && !els.panel.hidden) return;
      job = next;
      segments = [];
      shown = 0;
      els.list.replaceChildren();
      els.panel.hidden = false;
      try {
        els.srt.href = artifactUrl(baseUrl, next.id, "srt");
      } catch {
        failure = ApiError.local("bad_response");
        renderStatic();
        return;
      }
      renderStatic();
      void load();
    },
    hide() {
      controller?.abort();
      controller = null;
      job = null;
      segments = [];
      shown = 0;
      loading = false;
      failure = null;
      els.list.replaceChildren();
      els.panel.hidden = true;
    },
    /** Repinta los textos que dependen del idioma. */
    refresh() {
      if (job === null) return;
      renderStatic();
    },
    get segments() {
      return segments;
    },
  };
}
