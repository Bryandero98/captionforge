// Claves de proveedores externos del espacio activo (ADR 0020). Solo el Dueño, solo con sesión. El API nunca devuelve la clave:
// de una clave guardada solo se conoce el proveedor y sus últimos 4 caracteres.

import { ApiError } from "./errors.js";
import { requestJson } from "./jobs.js";

/** Proveedores que admite el API (external-key-crypto.ts); cualquier otro nombre ni sale hacia la red. */
export const EXTERNAL_PROVIDERS = /** @type {const} */ (["openai", "elevenlabs"]);

/** @typedef {typeof EXTERNAL_PROVIDERS[number]} ExternalProvider */
/** @typedef {{ provider: ExternalProvider, last4: string, createdAt: string, rotatedAt: string | null, baseUrlHost?: string | null, model?: string | null }} ExternalKeyView */
/** @typedef {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} Base */

const root = (/** @type {string} */ baseUrl) => `${baseUrl.replace(/\/+$/, "")}/v1/workspaces/current/external-keys`;

/** @param {string} provider @returns {ExternalProvider} */
function assertProvider(provider) {
  if (!EXTERNAL_PROVIDERS.includes(/** @type {ExternalProvider} */ (provider))) throw ApiError.local("invalid_request", "Proveedor desconocido.");
  return /** @type {ExternalProvider} */ (provider);
}

/** @param {Base} options @returns {Promise<ExternalKeyView[]>} */
export async function listExternalKeys({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {{ keys?: ExternalKeyView[] } | null} */ (await requestJson({ url: root(baseUrl), signal, fetchImpl }));
  if (!Array.isArray(data?.keys)) throw ApiError.local("bad_response");
  return data.keys;
}

/**
 * Guarda o reemplaza la clave de un proveedor. `endpoint` (URL base del servicio compatible) y `model` son opcionales y solo aplican a
 * OpenAI (ADR 0022); vacíos no se envían, y un reemplazo sin ellos los borra en el servidor.
 * @param {Base & { provider: string, key: string, endpoint?: string, model?: string }} options @returns {Promise<ExternalKeyView>}
 */
export async function saveExternalKey({ baseUrl, provider, key, endpoint, model, signal, fetchImpl }) {
  const name = assertProvider(provider);
  const body = { key, ...(endpoint?.trim() ? { baseUrl: endpoint.trim() } : {}), ...(model?.trim() ? { model: model.trim() } : {}) };
  return /** @type {ExternalKeyView} */ (await requestJson({ url: `${root(baseUrl)}/${name}`, method: "PUT", body, signal, fetchImpl }));
}

/** @param {Base & { provider: string }} options */
export async function deleteExternalKey({ baseUrl, provider, signal, fetchImpl }) {
  const name = assertProvider(provider);
  await requestJson({ url: `${root(baseUrl)}/${name}`, method: "DELETE", signal, fetchImpl });
}
