// Cuenta de quien inició sesión: quién es, qué proveedores hay y sus claves de API (ADR 0016). Las peticiones salen con la
// cookie de sesión (mismo origen) y la cabecera X-Requested-With que el API exige a lo que modifica (api/auth.js).

import { requestJson } from "./jobs.js";

const root = (/** @type {string} */ baseUrl) => baseUrl.replace(/\/+$/, "");
const isRecord = (/** @type {unknown} */ value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @typedef {{ id: string, name: string, prefix: string, createdAt: string, lastUsedAt: string | null, revokedAt: string | null }} ApiKeyView */
/** @typedef {{ tenant: { id: string, name: string }, user: { name: string | null, email: string | null, provider: string | null } | null }} Me */

/**
 * Proveedores configurados en el servidor. Nunca lanza: sin respuesta, ninguno.
 * @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string[]>}
 */
export async function getProviders({ baseUrl, signal, fetchImpl }) {
  try {
    const data = await requestJson({ url: `${root(baseUrl)}/auth/providers`, signal, fetchImpl });
    const providers = isRecord(data) ? /** @type {{ providers?: unknown }} */ (data).providers : null;
    return Array.isArray(providers) ? providers.filter((name) => name === "github" || name === "google") : [];
  } catch {
    return [];
  }
}

/** Quién soy. Lanza ApiError('unauthorized') si no hay sesión. @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options @returns {Promise<Me>} */
export async function getMe({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {Me} */ (await requestJson({ url: `${root(baseUrl)}/v1/me`, signal, fetchImpl }));
  if (!isRecord(data) || !isRecord(data.tenant)) throw new TypeError("Respuesta de /v1/me con una forma inesperada.");
  return data;
}

/** @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options */
export async function logout({ baseUrl, signal, fetchImpl }) {
  await requestJson({ url: `${root(baseUrl)}/auth/logout`, method: "POST", signal, fetchImpl });
}

/** @param {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options @returns {Promise<ApiKeyView[]>} */
export async function listKeys({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {{ keys?: ApiKeyView[] }} */ (await requestJson({ url: `${root(baseUrl)}/v1/keys`, signal, fetchImpl }));
  return Array.isArray(data?.keys) ? data.keys : [];
}

/**
 * Crea una clave. El valor completo (`key`) viene UNA vez: no hay forma de volver a verlo.
 * @param {{ baseUrl: string, name: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<ApiKeyView & { key: string }>}
 */
export async function createKey({ baseUrl, name, signal, fetchImpl }) {
  return /** @type {ApiKeyView & { key: string }} */ (await requestJson({ url: `${root(baseUrl)}/v1/keys`, method: "POST", body: { name }, signal, fetchImpl }));
}

/** @param {{ baseUrl: string, id: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} options */
export async function revokeKey({ baseUrl, id, signal, fetchImpl }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError(`Id de clave inválido: ${id}`);
  await requestJson({ url: `${root(baseUrl)}/v1/keys/${id}`, method: "DELETE", signal, fetchImpl });
}
