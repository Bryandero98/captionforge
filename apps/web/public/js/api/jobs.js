// Llamadas JSON al API de trabajos (todo menos la subida y el flujo SSE, que tienen su propio módulo).
// Cada una devuelve datos o lanza ApiError con código estable (api/errors.js); nunca texto del servidor para decidir.

import { authHeaders } from "./auth.js";
import { ApiError, errorFromResponse } from "./errors.js";
import { isTerminalStatus } from "./sse.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACTS = new Set(["srt", "segments", "waveform", "video", "audio", "source"]);
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
 * @param {"srt" | "segments" | "waveform" | "video" | "audio" | "source"} name
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
 * `template` y `canvas` (Issue #13, parte 2) piden subtítulos dinámicos; `canvas: "vertical"` compone el video en 9:16.
 * @param {{ baseUrl: string, jobId: string, style?: string, karaoke?: boolean, template?: string, canvas?: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 */
export async function startBurn({ baseUrl, jobId, style, karaoke, template, canvas, signal, fetchImpl }) {
  assertJobId(jobId);
  /** @type {Record<string, unknown>} */
  const body = {};
  if (style !== undefined) body.style = style;
  if (karaoke !== undefined) body.karaoke = karaoke;
  if (template !== undefined) body.template = template;
  if (canvas !== undefined) body.canvas = canvas;
  return asJobView(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/burn`, method: "POST", body, signal, fetchImpl }));
}

/**
 * Pide traducir los subtítulos de una transcripción (ADR 0020). `argos` es local; `openai` usa la clave propia del espacio y puede costar dinero.
 * @param {{ baseUrl: string, jobId: string, provider: "argos" | "openai", targetLanguage: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 */
export async function startTranslate({ baseUrl, jobId, provider, targetLanguage, signal, fetchImpl }) {
  assertJobId(jobId);
  return asJobView(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/translate`, method: "POST", body: { provider, targetLanguage }, signal, fetchImpl }));
}

/**
 * Pide doblar con voz sintética (siempre con la clave propia del espacio). `translationId` dobla una traducción ya terminada en vez del original.
 * @param {{ baseUrl: string, jobId: string, provider: "openai" | "elevenlabs", voice: string, mix: "none" | "replace" | "duck", translationId?: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 */
export async function startDub({ baseUrl, jobId, provider, voice, mix, translationId, signal, fetchImpl }) {
  assertJobId(jobId);
  const body = translationId === undefined ? { provider, voice, mix } : { provider, voice, mix, translationId };
  return asJobView(await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/dub`, method: "POST", body, signal, fetchImpl }));
}

// ---------- Calidad de subtítulos (ADR 0021) ----------
// El verificador vive solo en el API: aquí solo se pide el informe y se valida su forma. Ninguna regla se calcula en el navegador.

/** @typedef {{ id: string, label: string, verification: string, reference: string }} QualityProfile */
/** @typedef {{ segments: number, errors: number, warnings: number, infos: number, score: number }} QualitySummary */
/** @typedef {{ segment: number, rule: string, severity: "error" | "warning" | "info", measured: number, limit: number, line?: number }} QualityIssue */
/** @typedef {{ profile: string, etag: string, summary: QualitySummary, issues: QualityIssue[] }} QualityReport */
/** @typedef {{ segment: number, kind: "line_break" | "timing", before: { start: number, end: number, text: string }, after: { start: number, end: number, text: string } }} QualityChange */
/** @typedef {{ profile: string, etag: string, edits: { index: number, text?: string, start?: number, end?: number }[], changes: QualityChange[], unfixable: QualityIssue[], before: QualitySummary, after: QualitySummary }} QualityFix */

const PROFILE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const badResponse = (/** @type {string} */ detail) => new ApiError({ code: "bad_response", detail });

/** @param {string} profile */
function assertProfileId(profile) {
  if (!PROFILE_ID.test(profile)) throw new TypeError(`Perfil de calidad inválido: ${profile}`);
}

/** @param {unknown} value */
function isSummary(value) {
  const summary = /** @type {Record<string, unknown>} */ (value);
  return isRecord(value) && ["segments", "errors", "warnings", "infos", "score"].every((key) => Number.isFinite(summary[key]));
}

/** @param {unknown} value */
function isIssue(value) {
  const issue = /** @type {Record<string, unknown>} */ (value);
  return isRecord(value) && Number.isInteger(issue.segment) && typeof issue.rule === "string" && ["error", "warning", "info"].includes(/** @type {string} */ (issue.severity)) && Number.isFinite(issue.measured) && Number.isFinite(issue.limit);
}

/** @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options @returns {Promise<QualityProfile[]>} */
export async function getQualityProfiles({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {Record<string, unknown>} */ (await requestJson({ url: `${root(baseUrl)}/v1/quality/profiles`, signal, fetchImpl }));
  const valid = (/** @type {unknown} */ item) => {
    const profile = /** @type {Record<string, unknown>} */ (item);
    return isRecord(item) && typeof profile.id === "string" && typeof profile.label === "string";
  };
  if (!isRecord(data) || !Array.isArray(data.profiles) || !data.profiles.every(valid)) throw badResponse("Perfiles con una forma inesperada.");
  return /** @type {QualityProfile[]} */ (data.profiles);
}

/** Informe de calidad de una transcripción terminada. @param {{ baseUrl: string, jobId: string, profile: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options @returns {Promise<QualityReport>} */
export async function getQuality({ baseUrl, jobId, profile, signal, fetchImpl }) {
  assertJobId(jobId);
  assertProfileId(profile);
  const data = /** @type {Record<string, unknown>} */ (await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/quality?profile=${profile}`, signal, fetchImpl }));
  if (!isRecord(data) || typeof data.etag !== "string" || !isSummary(data.summary) || !Array.isArray(data.issues) || !data.issues.every(isIssue)) {
    throw badResponse("Informe de calidad con una forma inesperada.");
  }
  return /** @type {QualityReport} */ (data);
}

/**
 * Pide la propuesta de arreglo (solo tiempos y saltos de línea). No guarda nada: las `edits` se aplican con `putSegments` y el mismo `etag`.
 * @param {{ baseUrl: string, jobId: string, profile: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options @returns {Promise<QualityFix>}
 */
export async function proposeQualityFix({ baseUrl, jobId, profile, signal, fetchImpl }) {
  assertJobId(jobId);
  assertProfileId(profile);
  const data = /** @type {Record<string, unknown>} */ (await requestJson({ url: `${root(baseUrl)}/v1/jobs/${jobId}/quality/fix`, method: "POST", body: { profile }, signal, fetchImpl }));
  const validEdit = (/** @type {unknown} */ edit) => isRecord(edit) && Number.isInteger(/** @type {Record<string, unknown>} */ (edit).index);
  if (
    !isRecord(data) || typeof data.etag !== "string" || !Array.isArray(data.edits) || !data.edits.every(validEdit) ||
    !Array.isArray(data.changes) || !Array.isArray(data.unfixable) || !data.unfixable.every(isIssue) || !isSummary(data.before) || !isSummary(data.after)
  ) {
    throw badResponse("Propuesta de arreglo con una forma inesperada.");
  }
  return /** @type {QualityFix} */ (data);
}

export { isTerminalStatus };
