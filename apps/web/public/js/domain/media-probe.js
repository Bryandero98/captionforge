// Lectura local de los metadatos de un archivo (v1.3.0, iniciativa 1): duración y dimensiones con un <video>/<audio> fuera del DOM en
// preload="metadata". No sube nada ni decodifica el archivo entero, así que uno de 4 GiB cuesta lo mismo que uno de 4 MiB.
//
// Nunca bloquea ni lanza: sin metadatos a tiempo (4 s), con un formato que el navegador no lee (MKV, AVI en algunos) o sin entorno,
// devuelve `null` en los campos y el análisis cae al perfil Estándar. La URL del objeto se revoca siempre y una sola vez.

/** Tiempo máximo de espera de los metadatos. */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * @typedef {{ kind: "audio" | "video", durationSeconds: number | null, width: number | null, height: number | null }} ProbeResult
 * @typedef {{
 *   createElement: (tag: "audio" | "video") => any,
 *   createObjectURL: (file: any) => string,
 *   revokeObjectURL: (url: string) => void,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 * }} ProbeEnv
 */

/** @param {unknown} value @returns {number | null} */
const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/**
 * @param {{ name?: string, size?: number }} file el File elegido
 * @param {string} kind «audio» o cualquier otra cosa (= video); lo decide quien llama con las reglas de tipo de archivo
 * @param {ProbeEnv | null | undefined} env elementos, URL y reloj (el navegador real los trae; las pruebas, falsos)
 * @returns {Promise<ProbeResult>}
 */
export function probeMedia(file, kind, env) {
  const isAudio = kind === "audio";
  /** @type {ProbeResult} */
  const unknown = { kind: isAudio ? "audio" : "video", durationSeconds: null, width: null, height: null };
  if (!env) return Promise.resolve(unknown);

  return new Promise((resolve) => {
    /** @type {any} */
    let element;
    /** @type {string | null} */
    let url = null;
    /** @type {any} */
    let timer = null;
    let finished = false;

    /** @param {ProbeResult} result */
    function finish(result) {
      if (finished) return;
      finished = true;
      if (timer !== null) env?.clearTimeout(timer);
      if (element) {
        element.removeEventListener("loadedmetadata", onLoaded);
        element.removeEventListener("error", onError);
        try {
          element.removeAttribute("src");
          element.load?.(); // suelta el recurso: sin esto el navegador puede mantener el archivo abierto
        } catch {
          // un elemento ya descartado no necesita más
        }
      }
      if (url !== null) {
        try {
          env?.revokeObjectURL(url);
        } catch {
          // revocar una URL ya invalidada no es un fallo
        }
      }
      resolve(result);
    }

    function onLoaded() {
      finish({
        kind: unknown.kind,
        durationSeconds: positive(element.duration),
        // Un audio no tiene imagen: aunque el elemento diga algo, no se devuelven dimensiones.
        width: isAudio ? null : positive(element.videoWidth),
        height: isAudio ? null : positive(element.videoHeight),
      });
    }
    function onError() {
      finish(unknown);
    }

    try {
      element = env.createElement(isAudio ? "audio" : "video");
      element.preload = "metadata";
      element.muted = true;
      element.addEventListener("loadedmetadata", onLoaded);
      element.addEventListener("error", onError);
      url = env.createObjectURL(file);
      timer = env.setTimeout(() => finish(unknown), PROBE_TIMEOUT_MS);
      element.src = url;
    } catch {
      finish(unknown);
    }
  });
}
