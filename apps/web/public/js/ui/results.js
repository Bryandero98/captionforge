// Panel de resultados de una transcripción terminada: datos del trabajo, descargas (.srt del servidor, .vtt armado aquí)
// y el editor de subtítulos (ui/segment-editor.js). Todo texto entra con textContent.

import { ApiError } from "../api/errors.js";
import { fetchArtifact, saveBlobAs } from "../api/download.js";
import { artifactUrl, getSegments } from "../api/jobs.js";
import { cleanAudioStatus } from "../domain/clean-audio.js";
import { formatDuration } from "../domain/format.js";
import { diarizationStatus, segmentsToSrtWithSpeakers } from "../domain/speakers.js";
import { characterCount } from "../domain/spend.js";
import { segmentsToVtt } from "../domain/subtitles.js";
import { createSegmentEditor } from "./segment-editor.js";
import { createSourceAudio } from "./source-audio.js";

/**
 * Nombre de archivo para una descarga hecha en el cliente: el del video sin extensión y sin caracteres de ruta.
 * @param {string} originalFilename
 * @param {string} extension
 */
export function downloadName(originalFilename, extension) {
  const stem = Array.from(
    originalFilename
      .replace(/\.[A-Za-z0-9]{1,10}$/, "")
      // Rutas, controles y marcas de dirección/formato Unicode (un U+202E invertiría la extensión en el explorador).
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, ""),
  )
    .slice(0, 120) // por puntos de código: no parte un par sustituto
    .join("");
  // Nombres reservados de Windows (CON, NUL, COM1...) no son un nombre de archivo válido.
  const safe = stem === "" ? "captionforge" : /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `_${stem}` : stem;
  return `${safe}.${extension}`;
}

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string, t: (key: string, params?: Record<string, string | number>) => string,
 *   lang: () => string, announce: (text: string) => void, fetchSegments?: typeof getSegments,
 *   onChange?: () => void,
 * }} deps
 */
export function createResults({ doc, win, baseUrl, t, lang, announce, fetchSegments = getSegments, onChange = () => {} }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    panel: $("result-panel"),
    language: $("result-language"),
    cleanRow: $("result-clean-row"),
    clean: $("result-clean"),
    cleanNote: $("result-clean-note"),
    speakersRow: $("result-speakers-row"),
    speakers: $("result-speakers"),
    speakersNote: $("result-speakers-note"),
    prefix: $("dl-speaker-prefix"),
    duration: $("result-duration"),
    count: $("result-count"),
    srt: $("dl-srt"),
    vtt: $("dl-vtt"),
    hint: $("dl-hint"),
    status: $("result-status"),
    retry: $("result-retry"),
  };

  /** @type {import("../api/sse.js").JobView | null} */
  let job = null;
  /** @type {ApiError | null} */
  let failure = null;
  let loading = false;
  /** @type {AbortController | null} */
  let controller = null;

  const editor = createSegmentEditor({ doc, win, baseUrl, t, onChange: () => updateDownloads() });
  // Con un audio, el panel trae un <audio> estándar con el original (con un video no hay nada que mostrar aquí).
  const sourceAudio = createSourceAudio({ doc, baseUrl, t });

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
    // Solo si se pidió limpiar: un trabajo normal no muestra un «Audio limpiado: no» que nadie preguntó.
    const cleaning = cleanAudioStatus(/** @type {{ options?: unknown, result?: unknown } | null} */ (job));
    els.cleanRow.hidden = cleaning === "none";
    els.clean.textContent = cleaning === "cleaned" ? t("result.cleaned.yes") : t("result.cleaned.no");
    els.cleanNote.hidden = cleaning !== "fallback";
    els.cleanNote.textContent = cleaning === "fallback" ? t("result.cleaned.fallback") : "";
    // Igual que la limpieza: solo si se pidió identificar hablantes.
    const speakers = diarizationStatus(/** @type {{ options?: unknown, result?: unknown } | null} */ (job));
    const found = new Set(editor.segments.map((segment) => segment.speaker).filter(Boolean)).size;
    els.speakersRow.hidden = speakers === "none";
    els.speakers.textContent = speakers === "identified" ? String(found) : t("result.speakers.no");
    els.speakersNote.hidden = speakers !== "fallback";
    els.speakersNote.textContent = speakers === "fallback" ? t("result.speakers.fallback") : "";
  }

  /** Con cambios sin guardar las descargas darían la versión vieja: se desactivan y se dice por qué. */
  function updateDownloads() {
    const dirty = editor.dirty;
    els.vtt.disabled = dirty || editor.segments.length === 0;
    els.srt.setAttribute("aria-disabled", String(dirty));
    els.hint.hidden = !dirty;
    els.hint.textContent = dirty ? t("editor.downloads.hint") : "";
    onChange();
  }

  function renderStatic() {
    renderFacts();
    renderStatus();
    updateDownloads();
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
      editor.open(job.id, data.segments, data.etag);
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

  /** Entrega un archivo armado aquí. */
  function saveBlob(/** @type {string} */ text, /** @type {string} */ type, /** @type {"srt" | "vtt"} */ extension) {
    if (job === null) return;
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = doc.createElement("a");
    link.href = url;
    link.download = downloadName(typeof job.originalFilename === "string" ? job.originalFilename : "", extension);
    doc.body.append(link);
    link.click();
    link.remove();
    win.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** Con la casilla marcada, el nombre del hablante va delante del texto («Ana: Hola»). */
  const prefixer = () => (els.prefix.checked ? (/** @type {{ speaker?: string }} */ segment) => editor.speakerNameOf(segment) : undefined);

  /** Descarga el .vtt armado con los subtítulos guardados. */
  function downloadVtt() {
    if (job === null || editor.segments.length === 0 || editor.dirty) return;
    saveBlob(segmentsToVtt(editor.segments, prefixer()), "text/vtt", "vtt");
  }

  els.vtt.addEventListener("click", downloadVtt);
  els.srt.addEventListener("click", (/** @type {Event} */ event) => {
    // Un enlace no puede mandar la clave de API: el .srt del servidor se pide con fetch y se entrega como archivo.
    event.preventDefault();
    if (editor.dirty || job === null) return;
    if (els.prefix.checked && !els.panel.hidden && editor.segments.length > 0) {
      // El .srt del servidor no lleva nombres: con la casilla marcada se arma aquí con los guardados.
      saveBlob(segmentsToSrtWithSpeakers(editor.segments, (segment) => editor.speakerNameOf(segment)), "application/x-subrip", "srt");
      return;
    }
    void downloadServerSrt();
  });

  /** Baja el .srt del servidor con la clave de API. Un fallo se muestra en el estado del panel, como los demás. */
  async function downloadServerSrt() {
    const current = job;
    if (current === null) return;
    try {
      const response = await fetchArtifact({ baseUrl, jobId: current.id, name: "srt" });
      const blob = await response.blob();
      saveBlobAs({ doc, win, blob, filename: downloadName(typeof current.originalFilename === "string" ? current.originalFilename : "", "srt") });
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      failure = error instanceof ApiError ? error : ApiError.network();
      renderStatic();
    }
  }
  els.retry.addEventListener("click", () => void load());

  return {
    /** Muestra el resultado de una transcripción terminada y carga sus subtítulos. @param {import("../api/sse.js").JobView} next */
    show(next) {
      if (job?.id === next.id && !els.panel.hidden) return;
      job = next;
      els.prefix.checked = false;
      editor.close();
      els.panel.hidden = false;
      sourceAudio.show(next);
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
      if (job === null && els.panel.hidden) return;
      controller?.abort();
      controller = null;
      job = null;
      loading = false;
      failure = null;
      els.prefix.checked = false;
      editor.close();
      sourceAudio.hide();
      els.panel.hidden = true;
      onChange();
    },
    /** Vuelve a pedir los subtítulos guardados (tras aplicar un arreglo de calidad, por ejemplo). */
    reload() {
      return load();
    },
    /** Repinta los textos que dependen del idioma. */
    refresh() {
      if (job === null) return;
      renderStatic();
      editor.refresh();
      sourceAudio.refresh(job);
    },
    /** Hay cambios sin guardar en el editor. */
    get dirty() {
      return editor.dirty;
    },
    /** La transcripción abierta y si se puede quemar, o null si no hay subtítulos cargados. */
    get context() {
      if (job === null || editor.segments.length === 0) return null;
      const hasWords = editor.segments.some((segment) => Array.isArray(segment.words) && segment.words.length > 0);
      const language = /** @type {{ detectedLanguage?: unknown } | null} */ (job.result ?? null)?.detectedLanguage;
      return { job, hasWords, dirty: editor.dirty, characters: characterCount(editor.segments), language: typeof language === "string" ? language : null };
    },
  };
}
