// Qué funciones opcionales ofrece el servidor (GET /v1/capabilities). Es una mejora progresiva: si la consulta falla, es
// de un servidor antiguo o trae una forma rara, todo queda apagado y la interfaz funciona como siempre.

import { BURN_TEMPLATES, DEFAULT_VERTICAL_MAX_SECONDS, MAX_VERTICAL_MAX_SECONDS } from "../domain/burn-options.js";
import { EXTERNAL_PROVIDERS } from "./external-keys.js";

/** @typedef {{ diarization: { enabled: boolean }, byok: { enabled: boolean, providers: readonly string[], allowPrivateBaseUrls: boolean }, limits: { verticalMaxSeconds: number }, burn: { templates: readonly string[] }, assistant: { enabled: boolean, allowPrivateBaseUrls: boolean } }} Capabilities */

/** @type {Capabilities} */
export const NO_CAPABILITIES = Object.freeze({
  diarization: Object.freeze({ enabled: false }),
  byok: Object.freeze({ enabled: false, providers: Object.freeze([]), allowPrivateBaseUrls: false }),
  // Sin datos del servidor (o de un servidor anterior) rigen los valores de siempre.
  limits: Object.freeze({ verticalMaxSeconds: DEFAULT_VERTICAL_MAX_SECONDS }),
  burn: Object.freeze({ templates: BURN_TEMPLATES }),
  assistant: Object.freeze({ enabled: false, allowPrivateBaseUrls: false }),
});

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Capabilities>}
 */
export async function getCapabilities({ baseUrl, signal, fetchImpl = (...args) => fetch(...args) }) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/capabilities`, { cache: "no-store", headers: { Accept: "application/json" }, signal: timeout.signal });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return NO_CAPABILITIES;
    const data = /** @type {{ diarization?: { enabled?: unknown } | null, byok?: { enabled?: unknown, providers?: unknown, allowPrivateBaseUrls?: unknown } | null, limits?: { verticalMaxSeconds?: unknown } | null, burn?: { templates?: unknown } | null, assistant?: { enabled?: unknown, allowPrivateBaseUrls?: unknown } | null } | null} */ (await response.json());
    const byokOn = data?.byok?.enabled === true && Array.isArray(data.byok.providers);
    const providers = byokOn ? [...new Set(/** @type {unknown[]} */ (data?.byok?.providers))].filter((name) => typeof name === "string" && EXTERNAL_PROVIDERS.includes(/** @type {any} */ (name))) : [];
    const max = data?.limits?.verticalMaxSeconds;
    const verticalMaxSeconds = typeof max === "number" && Number.isInteger(max) && max > 0 && max <= MAX_VERTICAL_MAX_SECONDS ? max : DEFAULT_VERTICAL_MAX_SECONDS;
    // Solo las plantillas que la interfaz sabe dibujar; si no queda ninguna, las de siempre.
    const announced = Array.isArray(data?.burn?.templates) ? [...new Set(data.burn.templates)].filter((name) => BURN_TEMPLATES.includes(/** @type {any} */ (name))) : [];
    return {
      diarization: { enabled: data?.diarization?.enabled === true },
      byok: { enabled: byokOn, providers: /** @type {string[]} */ (providers), allowPrivateBaseUrls: byokOn && data?.byok?.allowPrivateBaseUrls === true },
      limits: { verticalMaxSeconds },
      burn: { templates: announced.length > 0 ? /** @type {string[]} */ (announced) : BURN_TEMPLATES },
      // Asistente (ADR 0028): solo en modo local. Las direcciones privadas (Ollama) solo si el servidor las permite.
      assistant: { enabled: data?.assistant?.enabled === true, allowPrivateBaseUrls: data?.assistant?.enabled === true && data.assistant.allowPrivateBaseUrls === true },
    };
  } catch {
    return NO_CAPABILITIES;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
