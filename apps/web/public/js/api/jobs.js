// Llamadas JSON al API de trabajos (todo menos la subida y el flujo SSE, que tienen su propio módulo).
// Cada una devuelve datos o lanza ApiError con código estable (api/errors.js); nunca texto del servidor para decidir.

import { authHeaders } from "./auth.js";
import { ApiError, errorFromResponse } from "./errors.js";
import { isTerminalStatus } from "./sse.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACTS = new Set(["srt", "segments", "waveform", "video"]);
const REQUEST_TIMEOUT_MS = 30_000;

/** @typedef {import("./sse.js").JobView} JobView */
/** @typedef {{ index: number, start: number, end: number, text: string, words: unknown[] | null }} Segment */

const root = (/** @type {string} */ baseUrl) => baseUrl.replace(/\/+$/, "");

/** @param {string} jobId */
function assertJobId(jobId) {
  if (!UUID.test(jobId)) throw new TypeError(`Id de trabajo inválido: ${jobId}`);
}

/**
 * URL de un artefacto. No sirve para navegar a ella: el API exige la clave en una cabecera, que un enlace no manda;
 * las descargas van por api/download.js (fetch + Blob).
 * @param {string} baseUrl
 * @param {string} jobId
 * @param {"srt" | "segments" | "waveform" | "video"} name
 */
export function artifactUrl(baseUrl, jobId, name) {
  assertJobId(jobId);
  if (!ARTIFACTS.has(name)) throw new TypeError(`Artefacto desconocido: ${name}`);
  return `${root(baseUrl)}/v1/jobs/${jobId}/artifacts/${name}`;
}

/**
 * @param {{ url: string, method?: string, body?: unknown, signal?: AbortSignal, fetchImpl?: typeof fetch }} request
 * @returns {Promise<unknown>}
 */
export async function requestJson({ url, method = "GET", body, signal, fetchImpl = (...args) => fetch(...args) }) {
  if (signal?.aborted) throw ApiError.aborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        cache: "no-store",
        headers: body === undefined ? { ...authHeaders(), Accept: "application/json" } : { ...authHeaders(), Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
      });
    } catch {
      if (signal?.aborted) throw ApiError.aborted();
      throw timeout.signal.aborted ? ApiError.timeout() : ApiError.network();
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw errorFromResponse(response.status, text, response.headers.get("retry-after"));
    if (response.status === 204) return null;
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new ApiError({ status: response.status, code: "bad_response" });
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError({ status: response.status, code: "bad_response" });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

const isRecord = (/** @type {unknown} */ value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value @returns {JobView} */
function asJobView(value) {
  const job = /** @type {Record<string, unknown>} */ (value);
  if (!isRecord(value) || typeof job.id !== "string" || typeof job.status !== "string" || typeof job.percent !== "number") {
    throw new ApiError({ code: "bad_response", detail: "Trabajo con una forma inesperada." });
  }
  return /** @type {JobView} */ (value);
}

/** @param {{ baseUrl: string, jobId: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options */
export async function getJob({ baseUrl, jobId, signal, fetchImpl }) {
  assertJobId(jobId);
  return asJobView(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}`, signal, fetchImpl }));
}

/** @param {{ baseUrl: string, jobId: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options */
export async function cancelJob({ baseUrl, jobId, signal, fetchImpl }) {
  assertJobId(jobId);
  return asJobView(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/cancel`, method: "POST", signal, fetchImpl }));
}

/**
 * Subtítulos de una transcripción terminada, con el `etag` que se manda al editar.
 * @param {{ baseUrl: string, jobId: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ segments: Segment[], etag: string }>}
 */
export async function getSegments({ baseUrl, jobId, signal, fetchImpl }) {
  assertJobId(jobId);
  return asSegments(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/segments`, signal, fetchImpl }));
}

/**
 * Edita texto y/o tiempos por índice. Con `etag`, el API responde 409 si los subtítulos cambiaron desde que se leyeron.
 * @param {{ baseUrl: string, jobId: string, edits: { index: number, text?: string, start?: number, end?: number }[], etag?: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ segments: Segment[], etag: string }>}
 */
export async function putSegments({ baseUrl, jobId, edits, etag, signal, fetchImpl }) {
  assertJobId(jobId);
  const body = etag === undefined ? { segments: edits } : { segments: edits, etag };
  return asSegments(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/segments`, method: "PUT", body, signal, fetchImpl }));
}

/** @param {unknown} value */
function asSegments(value) {
  const data = /** @type {Record<string, unknown>} */ (value);
  const valid = (/** @type {unknown} */ item) => {
    const segment = /** @type {Record<string, unknown>} */ (item);
    return isRecord(item) && typeof segment.text === "string" && Number.isFinite(segment.start) && Number.isFinite(segment.end);
  };
  if (!isRecord(value) || !Array.isArray(data.segments) || typeof data.etag !== "string" || !data.segments.every(valid)) {
    throw new ApiError({ code: "bad_response", detail: "Subtítulos con una forma inesperada." });
  }
  return /** @type {{ segments: Segment[], etag: string }} */ (value);
}

/**
 * Pide quemar los subtítulos actuales sobre el video; devuelve el trabajo de quemado (se sigue con followJob).
 * @param {{ baseUrl: string, jobId: string, style?: string, karaoke?: boolean, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 */
export async function startBurn({ baseUrl, jobId, style, karaoke, signal, fetchImpl }) {
  assertJobId(jobId);
  /** @type {Record<string, unknown>} */
  const body = {};
  if (style !== undefined) body.style = style;
  if (karaoke !== undefined) body.karaoke = karaoke;
  return asJobView(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/burn`, method: "POST", body, signal, fetchImpl }));
}

export { isTerminalStatus };
