// Cliente SSE propio (ADR 0012): fetch + ReadableStream en lugar de EventSource, para poder leer el código de estado
// y el Retry-After de un 429/503, y para decidir nosotros cuándo y cuánto reintentar.
//
// Tres capas: SseParser (formato text/event-stream, puro), streamJobEvents (una conexión: abre, lee, entrega eventos)
// y followJob (sigue un trabajo hasta un estado final reconectando si el flujo se corta).

import { ApiError, errorFromResponse } from "./errors.js";

const STATUSES = new Set(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** El API manda un ping cada 15 s: tres seguidos sin llegar es una conexión muerta (típico de un proxy que la retiene). */
const DEFAULT_STALE_MS = 45_000;
const DEFAULT_MAX_FAILURES = 8;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
/** Espera cuando el servidor rechaza el flujo sin decir cuánto (el API manda 30). */
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Una conexión que dura menos que esto no se considera sana: reconectar a cada corte corto sería martillear al servidor. */
const HEALTHY_STREAM_MS = 5000;
/** Tope de lo que el parser retiene sin ver un fin de línea o de evento: un flujo defectuoso no debe agotar la memoria. */
const MAX_PENDING_CHARS = 1024 * 1024;

/**
 * @typedef {{ id: string, status: "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED"|"CANCELLED", stage: string | null, percent: number,
 *   message: string | null, error?: { code: string, message: string | null } | null, [key: string]: unknown }} JobView
 */

/** @param {unknown} status */
export function isTerminalStatus(status) {
  return typeof status === "string" && TERMINAL.has(status);
}

/**
 * Interpreta el cuerpo de un evento «job». Un dato que no cumple la forma esperada es una respuesta que no es del API.
 * @param {string} text
 * @returns {JobView}
 */
export function parseJobView(text) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError({ code: "bad_response", detail: "Evento «job» que no es JSON." });
  }
  const job = /** @type {Record<string, unknown>} */ (value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof job.id !== "string" || typeof job.status !== "string" || !STATUSES.has(job.status) || typeof job.percent !== "number" || !Number.isFinite(job.percent)) {
    throw new ApiError({ code: "bad_response", detail: "Evento «job» con una forma inesperada." });
  }
  return /** @type {JobView} */ ({ ...job, percent: Math.min(100, Math.max(0, job.percent)) });
}

/**
 * Analizador incremental de text/event-stream (WHATWG HTML, «Server-sent events»). Recibe texto ya decodificado, en
 * trozos de cualquier tamaño, y entrega cada evento completo.
 */
export class SseParser {
  /** @param {(event: { type: string, data: string }) => void} onEvent */
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = "";
    this.started = false;
    this.type = "";
    /** @type {string[]} */
    this.data = [];
    this.dataSize = 0;
  }

  /** @param {string} chunk */
  push(chunk) {
    let text = this.buffer + chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      // Un «\r» al final del trozo puede ser la mitad de un «\r\n»: se espera al siguiente trozo para saberlo.
      if (code === 13 && i === text.length - 1) break;
      this.line(text.slice(start, i));
      if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    this.buffer = text.slice(start);
    if (this.buffer.length + this.dataSize > MAX_PENDING_CHARS) throw new ApiError({ code: "bad_response", detail: "Evento SSE demasiado grande." });
  }

  /** @param {string} line */
  line(line) {
    if (line === "") {
      if (this.data.length > 0) this.onEvent({ type: this.type || "message", data: this.data.join("\n") });
      this.type = "";
      this.data = [];
      this.dataSize = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.type = value;
    else if (field === "data") {
      this.data.push(value);
      this.dataSize += value.length;
    }
    // «id» y «retry» no se usan: la reconexión es nuestra y el API reenvía el estado entero al conectar.
  }
}

/**
 * Una conexión al flujo de eventos de un trabajo.
 * Devuelve cómo terminó: «terminal» (el trabajo llegó a un estado final), «ended» (el servidor cerró el flujo) o
 * «stale» (no llegó nada durante `staleMs`). Lanza ApiError si no pudo conectar, si el flujo falló o si se abortó.
 * @param {{
 *   baseUrl: string, jobId: string, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   onJob: (job: JobView) => void, onPing?: () => void, staleMs?: number,
 * }} options
 * @returns {Promise<{ reason: "terminal" | "ended" | "stale", job: JobView | null }>}
 */
export async function streamJobEvents({ baseUrl, jobId, signal, fetchImpl = (...args) => fetch(...args), onJob, onPing, staleMs = DEFAULT_STALE_MS }) {
  if (signal?.aborted) throw ApiError.aborted();
  const inner = new AbortController();
  const abortInner = () => inner.abort();
  signal?.addEventListener("abort", abortInner, { once: true });
  let stale = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stale = true;
      inner.abort();
    }, staleMs);
  };
  const outcomeOfAbort = () => {
    if (signal?.aborted) throw ApiError.aborted();
    return stale;
  };
  /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
  let reader;
  /** @type {JobView | null} */
  let last = null;
  try {
    arm();
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/events`, {
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        signal: inner.signal,
      });
    } catch {
      if (outcomeOfAbort()) return { reason: "stale", job: null };
      throw ApiError.network();
    }
    if (!response.ok) {
      if (signal?.aborted) throw ApiError.aborted();
      throw errorFromResponse(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || response.body === null) {
      throw new ApiError({ status: response.status, code: "bad_response" });
    }
    reader = response.body.getReader();
    const activeReader = reader;
    inner.signal.addEventListener("abort", () => void activeReader.cancel().catch(() => {}), { once: true });
    if (inner.signal.aborted) void activeReader.cancel().catch(() => {});

    const decoder = new TextDecoder();
    let terminal = false;
    const parser = new SseParser((event) => {
      if (terminal) return;
      if (event.type === "ping") return onPing?.();
      if (event.type !== "job") return;
      const job = parseJobView(event.data);
      if (job.id !== jobId) throw new ApiError({ code: "bad_response", detail: "Evento de otro trabajo." });
      last = job;
      onJob(job);
      if (isTerminalStatus(job.status)) terminal = true;
    });

    for (;;) {
      let result;
      try {
        result = await activeReader.read();
      } catch {
        if (outcomeOfAbort()) return { reason: "stale", job: last };
        throw ApiError.network();
      }
      if (result.done) break;
      arm();
      parser.push(decoder.decode(result.value, { stream: true }));
      if (signal?.aborted) throw ApiError.aborted();
      if (terminal) {
        void activeReader.cancel().catch(() => {});
        return { reason: "terminal", job: last };
      }
    }
    if (outcomeOfAbort()) return { reason: "stale", job: last };
    return { reason: "ended", job: last };
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", abortInner);
    inner.abort();
    void reader?.cancel().catch(() => {});
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve(undefined);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Sigue un trabajo hasta que llega a COMPLETED, FAILED o CANCELLED, reconectando si el flujo se corta: el API reenvía el
 * estado completo en cada conexión, así que reconectar no pierde nada. Devuelve el trabajo en su estado final.
 * Falla con el último error si es definitivo (404, 400...) o tras `maxFailures` intentos seguidos sin recibir nada.
 * @param {{
 *   baseUrl: string, jobId: string, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   onJob: (job: JobView) => void,
 *   onConnection?: (state: { kind: "connecting" | "reconnecting" | "live" } | { kind: "waiting", seconds: number }) => void,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>, staleMs?: number, maxFailures?: number, now?: () => number,
 * }} options
 * @returns {Promise<JobView>}
 */
export async function followJob({ baseUrl, jobId, signal, fetchImpl, onJob, onConnection, sleep = defaultSleep, staleMs, maxFailures = DEFAULT_MAX_FAILURES, now = Date.now }) {
  let failures = 0;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw ApiError.aborted();
    onConnection?.({ kind: attempt === 0 ? "connecting" : "reconnecting" });
    attempt++;
    const startedAt = now();
    let progressed = false;
    const live = () => {
      if (!progressed) onConnection?.({ kind: "live" });
      progressed = true;
    };
    /** @type {ApiError | null} */
    let failure = null;
    try {
      const outcome = await streamJobEvents({
        baseUrl,
        jobId,
        signal,
        fetchImpl,
        staleMs,
        onJob: (job) => (live(), onJob(job)),
        onPing: live,
      });
      if (outcome.reason === "terminal" && outcome.job !== null) return outcome.job;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "aborted") throw error;
      if (!error.retryable && error.code !== "bad_response") throw error;
      failure = error;
    }
    // Solo un flujo que dio datos Y duró lo bastante estaba sano. Si no, reconectar de inmediato en bucle sería martillear
    // al servidor (un proxy que corta a los pocos segundos); cuenta como fallo y espera con la escala de siempre.
    const healthy = progressed && now() - startedAt >= HEALTHY_STREAM_MS;
    if (healthy) failures = 0;
    if (healthy && failure === null) continue; // el servidor cerró (tope de duración): reconectar ya
    failures++;
    if (failures >= maxFailures) throw failure ?? ApiError.network();
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (failures - 1));
    const delay = failure?.retryAfter != null ? Math.max(1, failure.retryAfter) * 1000 : failure && (failure.code === "rate_limited" || failure.code === "busy") ? DEFAULT_RETRY_AFTER_MS : backoff;
    onConnection?.({ kind: "waiting", seconds: Math.ceil(delay / 1000) });
    await sleep(delay, signal);
    if (signal?.aborted) throw ApiError.aborted();
  }
}
