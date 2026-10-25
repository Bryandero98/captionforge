// Reproductor del audio original (Issue #14): con un audio, el panel de resultados muestra un <audio controls> estándar para
// escuchar mientras se editan los subtítulos (con un video no hay nada que mostrar aquí). El audio se pide con la clave de API
// (un <audio src> no puede mandarla) como artefacto «source» y suena desde un Blob. Si ya no existe o es demasiado grande,
// el reproductor simplemente no aparece: los subtítulos y las descargas siguen funcionando.

import { PREVIEW_MAX_BYTES, fetchArtifact as defaultFetchArtifact } from "../api/download.js";
import { ApiError } from "../api/errors.js";
import { isAudioJob } from "../domain/media.js";

/**
 * @param {{ doc: Document, baseUrl: string, fetchArtifact?: typeof defaultFetchArtifact, t?: (key: string, params?: Record<string, string | number>) => string }} deps
 */
export function createSourceAudio({ doc, baseUrl, fetchArtifact = defaultFetchArtifact, t = (key) => key }) {
  const player = /** @type {any} */ (doc.getElementById("result-audio"));
  if (!player) throw new Error("Falta el elemento #result-audio");

  /** @type {string | null} */
  let shownFor = null;
  /** @type {AbortController | null} */
  let load = null;
  /** @type {string | null} */
  let objectUrl = null;

  /** Suelta el audio: sin esto sigue sonando y con la conexión abierta aunque el panel esté oculto. */
  function clear() {
    load?.abort();
    load = null;
    player.pause();
    player.removeAttribute("src");
    player.load();
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    player.hidden = true;
    shownFor = null;
  }

  /** @param {{ id: string, originalFilename?: unknown }} job */
  async function fetchAndPlay(job) {
    const abort = new AbortController();
    load = abort;
    try {
      const response = await fetchArtifact({ baseUrl, jobId: job.id, name: "source", signal: abort.signal });
      const size = Number(response.headers.get("content-length"));
      if (Number.isFinite(size) && size > PREVIEW_MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const blob = await response.blob();
      if (abort.signal.aborted || shownFor !== job.id) return;
      objectUrl = URL.createObjectURL(blob);
      player.src = objectUrl;
      player.hidden = false;
    } catch (error) {
      if (abort.signal.aborted) return;
      // 404: el original caducó. Cualquier otro fallo tampoco debe estorbar: el reproductor no aparece.
      if (!(error instanceof ApiError)) console.error(error);
    } finally {
      if (load === abort) load = null;
    }
  }

  return {
    /** Muestra el reproductor si el trabajo es un audio. @param {{ id: string, mediaKind?: unknown, originalFilename?: unknown }} job */
    show(job) {
      if (shownFor === job.id) return;
      clear();
      if (!isAudioJob(job)) return;
      shownFor = job.id;
      const name = typeof job.originalFilename === "string" && job.originalFilename !== "" ? job.originalFilename : "";
      player.setAttribute("aria-label", name === "" ? t("audio.player.label") : t("audio.player.labelNamed", { name }));
      void fetchAndPlay(job);
    },
    hide() {
      clear();
    },
    /** Repinta el texto que depende del idioma. @param {Record<string, unknown> | null} job */
    refresh(job) {
      if (shownFor === null || job === null) return;
      const name = typeof job.originalFilename === "string" && job.originalFilename !== "" ? job.originalFilename : "";
      player.setAttribute("aria-label", name === "" ? t("audio.player.label") : t("audio.player.labelNamed", { name }));
    },
  };
}
