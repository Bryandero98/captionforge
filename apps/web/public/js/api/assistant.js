// Chat del asistente (POST /v1/assistant/chat, solo modo local). La IA de la persona viaja en el cuerpo y el servidor no la guarda.

import { ApiError } from "./errors.js";
import { requestJson } from "./jobs.js";

const CHAT_TIMEOUT_MS = 70_000; // el servidor espera hasta 60 s a la IA

/**
 * @param {{
 *   baseUrl: string,
 *   messages: { role: string, content: string }[],
 *   ai: { key: string, baseUrl?: string, model?: string },
 *   jobId?: string,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<string>}
 */
export async function sendChat({ baseUrl, messages, ai, jobId, signal, fetchImpl }) {
  const data = await requestJson({
    url: `${baseUrl.replace(/\/+$/, "")}/v1/assistant/chat`,
    method: "POST",
    body: { messages, ai, ...(jobId === undefined ? {} : { jobId }) },
    signal,
    fetchImpl,
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  const reply = data !== null && typeof data === "object" ? /** @type {{ reply?: unknown }} */ (data).reply : undefined;
  if (typeof reply !== "string" || reply.trim() === "") throw ApiError.local("bad_response");
  return reply;
}
