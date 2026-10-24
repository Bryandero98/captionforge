// Configuración de IA del espacio que puede ver cualquier miembro (ADR 0022): el host y el modelo de OpenAI, para que la confirmación de
// gasto diga a dónde va el texto. Nunca la URL completa ni la clave: el API no las devuelve.

import { ApiError } from "./errors.js";
import { requestJson } from "./jobs.js";

/** @typedef {{ model: string | null, baseUrlHost: string | null }} OpenAiConfig */
/** @typedef {{ openai: OpenAiConfig | null }} AiConfig */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const textOrNull = (/** @type {unknown} */ value) => value === null || typeof value === "string";

/**
 * @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<AiConfig>}
 */
export async function getAiConfig({ baseUrl, signal, fetchImpl }) {
  const data = await requestJson({ url: `${baseUrl.replace(/\/+$/, "")}/v1/workspaces/current/ai-config`, signal, fetchImpl });
  if (!isRecord(data) || !("openai" in data)) throw ApiError.local("bad_response");
  const openai = data.openai;
  if (openai === null) return { openai: null };
  if (!isRecord(openai)) throw ApiError.local("bad_response");
  const { model, baseUrlHost } = openai;
  if (!textOrNull(model) || !textOrNull(baseUrlHost)) throw ApiError.local("bad_response");
  // Solo se conserva lo conocido: un campo de más (p. ej. una clave que no debería estar) no llega a la interfaz.
  return { openai: { model: /** @type {string | null} */ (model), baseUrlHost: /** @type {string | null} */ (baseUrlHost) } };
}
