// Subida de un video a POST /v1/jobs/transcribe con XMLHttpRequest.
// Por qué XHR y no fetch: fetch no informa del progreso de la subida y XHR sí (xhr.upload.onprogress).
//
// Lo que hay que saber del API (apps/api-gateway):
//  - `options` (JSON) debe ir ANTES de `file`: el API responde en cuanto llega el archivo y no lee lo posterior.
//  - El 202 llega solo cuando TODO el archivo ya está en S3: de ahí la fase "finalizing" tras el último byte.
//  - Valida el mimetype que informa el navegador, no la extensión (un .mkv en Windows llega a veces vacío).
//  - El API descarta hasta 16 MiB del cuerpo tras un rechazo temprano, así que 408/413/429/403/421 llegan con su código.
//    Con cuerpos mayores el navegador puede ver solo un corte (status 0): por eso 'network' es ambiguo y precheckFile
//    es la defensa real del tamaño.

import { ApiError, errorFromResponse } from "./errors.js";

/** Extensión -> tipo que el API acepta. */
const MIME_BY_EXTENSION = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

export const ALLOWED_MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));
export const MODEL_SIZES = ["base", "small", "medium"];
export const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;

const LANGUAGE_CODE = /^[a-z]{2,3}$/;

/** El tipo que se envía: el del navegador si el API lo acepta; si no, el que corresponde a la extensión. */
export function videoMimeType(/** @type {File} */ file) {
  if (ALLOWED_MIME_TYPES.has(file.type)) return file.type;
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  return /** @type {Record<string, string>} */ (MIME_BY_EXTENSION)[extension] ?? file.type;
}

/**
 * Problemas que se pueden ver sin tocar la red. Es una ayuda, no la defensa: el API vuelve a validar todo.
 * @returns {ApiError | null}
 */
export function precheckFile(/** @type {File} */ file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (file.size === 0) return ApiError.local("invalid_request", "El archivo está vacío.");
  if (file.size > maxBytes) return ApiError.local("too_large");
  if (!ALLOWED_MIME_TYPES.has(videoMimeType(file))) return ApiError.local("unsupported_type");
  return null;
}

/**
 * Opciones tal como las espera el API: claves exactas, vacío = null (una cadena vacía recibiría 400).
 * @param {{ modelSize?: string, sourceLanguage?: string | null, translateTo?: string | null, cleanAudio?: boolean }} input
 */
export function normalizeOptions(input) {
  const modelSize = input.modelSize === undefined || input.modelSize === "" ? "small" : input.modelSize;
  if (!MODEL_SIZES.includes(modelSize)) throw new Error(`modelSize debe ser ${MODEL_SIZES.join(", ")} (recibido "${modelSize}")`);
  const language = (/** @type {string} */ name, /** @type {string | null | undefined} */ value) => {
    if (value === undefined || value === null || value === "") return null;
    if (!LANGUAGE_CODE.test(value)) throw new Error(`${name} debe ser un código de idioma en minúsculas, como "es" (recibido "${value}")`);
    return value;
  };
  if (input.cleanAudio !== undefined && typeof input.cleanAudio !== "boolean") throw new Error(`cleanAudio debe ser verdadero o falso (recibido ${JSON.stringify(input.cleanAudio)})`);
  return {
    modelSize,
    sourceLanguage: language("sourceLanguage", input.sourceLanguage),
    translateTo: language("translateTo", input.translateTo),
    cleanAudio: input.cleanAudio ?? false,
  };
}

/**
 * @typedef {{ phase: "uploading" | "finalizing", loaded: number, total: number, fraction: number }} UploadProgress
 */

/**
 * Sube un video y devuelve el trabajo creado (JobView) cuando el API lo acepta (202).
 * @param {{
 *   file: File,
 *   options: { modelSize?: string, sourceLanguage?: string | null, translateTo?: string | null, cleanAudio?: boolean },
 *   baseUrl?: string,
 *   maxBytes?: number,
 *   signal?: AbortSignal,
 *   onProgress?: (event: UploadProgress) => void,
 *   createXhr?: () => XMLHttpRequest,
 * }} request
 * @returns {Promise<{ id: string } & Record<string, unknown>>}
 */
export function uploadVideo({ file, options, baseUrl = "", maxBytes = DEFAULT_MAX_BYTES, signal, onProgress, createXhr = () => new XMLHttpRequest() }) {
  return new Promise((resolve, reject) => {
    const problem = precheckFile(file, { maxBytes });
    if (problem) return reject(problem);
    if (signal?.aborted) return reject(ApiError.aborted());

    /** @type {ReturnType<typeof normalizeOptions>} */
    let normalized;
    try {
      normalized = normalizeOptions(options);
    } catch (error) {
      return reject(ApiError.local("invalid_request", error instanceof Error ? error.message : null));
    }

    // `options` primero: el orden de los append es el orden en el cuerpo.
    const form = new FormData();
    form.append("options", JSON.stringify(normalized));
    form.append("file", new File([file], file.name, { type: videoMimeType(file) }));

    const xhr = createXhr();
    let settled = false;
    let total = file.size;

    const onAbort = () => {
      if (!settled) xhr.abort(); // dispara xhr.onabort, que rechaza
    };
    const finish = (/** @type {(value: any) => void} */ settle, /** @type {unknown} */ value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      settle(value);
    };
    const emit = (/** @type {UploadProgress} */ event) => {
      try {
        onProgress?.(event);
      } catch {
        // Un fallo al pintar el progreso no debe romper la subida.
      }
    };

    xhr.open("POST", `${baseUrl}/v1/jobs/transcribe`);
    xhr.responseType = "text";
    xhr.timeout = 0; // un video grande puede tardar horas; lo lento lo corta el API con 408

    xhr.upload.onprogress = (event) => {
      if (settled || !event.lengthComputable || !(event.total > 0)) return;
      total = event.total;
      emit({ phase: "uploading", loaded: event.loaded, total, fraction: Math.min(1, Math.max(0, event.loaded / event.total)) });
    };
    xhr.upload.onload = () => {
      if (!settled) emit({ phase: "finalizing", loaded: total, total, fraction: 1 });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        /** @type {any} */
        let job = null;
        try {
          job = JSON.parse(xhr.responseText);
        } catch {
          // no es JSON: se rechaza abajo
        }
        if (job !== null && typeof job === "object" && typeof job.id === "string") return finish(resolve, job);
        return finish(reject, new ApiError({ status: xhr.status, code: "bad_response" }));
      }
      finish(reject, errorFromResponse(xhr.status, xhr.responseText, xhr.getResponseHeader("retry-after")));
    };
    xhr.onerror = () => finish(reject, ApiError.network());
    xhr.ontimeout = () => finish(reject, ApiError.timeout());
    xhr.onabort = () => finish(reject, ApiError.aborted());

    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(form);
  });
}
