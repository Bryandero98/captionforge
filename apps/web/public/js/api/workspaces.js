// Equipos (ADR 0019): espacios de trabajo, miembros e invitaciones. Todo va con la cookie de sesión y la cabecera anti-CSRF (api/auth.js).

import { ApiError } from "./errors.js";
import { requestJson } from "./jobs.js";

const root = (/** @type {string} */ baseUrl) => baseUrl.replace(/\/+$/, "");

/** Una respuesta rota no es «lista vacía»: se avisa en vez de mostrar «no hay miembros». @template T @param {T[] | undefined} value @returns {T[]} */
function list(value) {
  if (!Array.isArray(value)) throw ApiError.local("bad_response");
  return value;
}

/** @typedef {"OWNER" | "EDITOR" | "VIEWER"} Role */
/** @typedef {{ id: string, name: string, role: Role, active: boolean }} Workspace */
/** @typedef {{ userId: string, name: string | null, email: string | null, provider: string | null, role: Role, joinedAt: string }} Member */
/** @typedef {{ id: string, role: Role, createdAt: string, expiresAt: string }} Invite */

/** @typedef {{ baseUrl: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} Base */

/** @param {Base} options @returns {Promise<Workspace[]>} */
export async function listWorkspaces({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {{ workspaces?: Workspace[] }} */ (await requestJson({ url: `${root(baseUrl)}/v1/workspaces`, signal, fetchImpl }));
  return list(data?.workspaces);
}

/** Cambia el espacio activo de esta sesión. @param {Base & { tenantId: string }} options */
export async function switchWorkspace({ baseUrl, tenantId, signal, fetchImpl }) {
  return /** @type {{ tenant: { id: string, name: string }, role: Role }} */ (await requestJson({ url: `${root(baseUrl)}/v1/me/workspace`, method: "POST", body: { tenantId }, signal, fetchImpl }));
}

/** @param {Base} options @returns {Promise<Member[]>} */
export async function listMembers({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {{ members?: Member[] }} */ (await requestJson({ url: `${root(baseUrl)}/v1/workspaces/members`, signal, fetchImpl }));
  return list(data?.members);
}

/** @param {Base & { userId: string, role: Role }} options */
export async function setMemberRole({ baseUrl, userId, role, signal, fetchImpl }) {
  await requestJson({ url: `${root(baseUrl)}/v1/workspaces/members/${encodeURIComponent(userId)}`, method: "PUT", body: { role }, signal, fetchImpl });
}

/** @param {Base & { userId: string }} options */
export async function removeMember({ baseUrl, userId, signal, fetchImpl }) {
  await requestJson({ url: `${root(baseUrl)}/v1/workspaces/members/${encodeURIComponent(userId)}`, method: "DELETE", signal, fetchImpl });
}

/** @param {Base} options @returns {Promise<Invite[]>} */
export async function listInvites({ baseUrl, signal, fetchImpl }) {
  const data = /** @type {{ invites?: Invite[] }} */ (await requestJson({ url: `${root(baseUrl)}/v1/workspaces/invites`, signal, fetchImpl }));
  return list(data?.invites);
}

/** Crea un enlace de un solo uso. El enlace viene UNA vez. @param {Base & { role: "EDITOR" | "VIEWER" }} options @returns {Promise<Invite & { link: string }>} */
export async function createInvite({ baseUrl, role, signal, fetchImpl }) {
  return /** @type {Invite & { link: string }} */ (await requestJson({ url: `${root(baseUrl)}/v1/workspaces/invites`, method: "POST", body: { role }, signal, fetchImpl }));
}

/** @param {Base & { id: string }} options */
export async function revokeInvite({ baseUrl, id, signal, fetchImpl }) {
  await requestJson({ url: `${root(baseUrl)}/v1/workspaces/invites/${encodeURIComponent(id)}`, method: "DELETE", signal, fetchImpl });
}

/** Consume una invitación. Sin sesión el API responde 401. @param {Base & { token: string }} options */
export async function acceptInvite({ baseUrl, token, signal, fetchImpl }) {
  return /** @type {{ tenant: { id: string, name: string }, role: Role }} */ (
    await requestJson({ url: `${root(baseUrl)}/v1/workspaces/invites/${encodeURIComponent(token)}/accept`, method: "POST", signal, fetchImpl })
  );
}

/** Qué espacio y rol ofrece un enlace, SIN consumirlo (ADR 0019). @param {Base & { token: string }} options @returns {Promise<{ tenant: { id: string, name: string }, role: Role }>} */
export async function previewInvite({ baseUrl, token, signal, fetchImpl }) {
  return /** @type {{ tenant: { id: string, name: string }, role: Role }} */ (await requestJson({ url: `${root(baseUrl)}/v1/workspaces/invites/${encodeURIComponent(token)}`, signal, fetchImpl }));
}
