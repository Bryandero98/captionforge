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
 * @returns {Promise<{ reply: string, actions: { name: string, args: Record<string, unknown> }[] }>}
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
  const body = data !== null && typeof data === "object" ? /** @type {{ reply?: unknown, actions?: unknown }} */ (data) : {};
  const reply = typeof body.reply === "string" ? body.reply.trim() : "";
  // Solo se conserva lo que tiene forma de acción; la página vuelve a validar nombre y argumentos antes de usarla.
  const actions = (Array.isArray(body.actions) ? body.actions : [])
    .filter((item) => item !== null && typeof item === "object" && typeof (/** @type {{ name?: unknown }} */ (item)).name === "string")
    .map((item) => {
      const action = /** @type {{ name: string, args?: unknown }} */ (item);
      const args = action.args !== null && typeof action.args === "object" && !Array.isArray(action.args) ? /** @type {Record<string, unknown>} */ (action.args) : {};
      return { name: action.name, args };
    });
  if (reply === "" && actions.length === 0) throw ApiError.local("bad_response");
  return { reply, actions };
}
