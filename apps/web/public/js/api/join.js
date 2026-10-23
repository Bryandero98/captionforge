// Unirse a un equipo con un enlace (ADR 0019). Una invitación NUNCA se consume sola: primero se pide al API una vista previa que no
// gasta nada (a qué espacio y con qué rol), la interfaz la muestra, y solo un clic explícito llama a «aceptar».
// Qué se hace con el token guardado: se borra cuando ya no sirve de nada (se usó, o el API dice 404/410/400) y se CONSERVA ante un fallo
// pasajero (red, 5xx, 429), porque entonces el servidor no lo gastó y la persona puede reintentar.

import { ApiError } from "./errors.js";
import { clearInvite } from "./invite.js";
import { acceptInvite, previewInvite, switchWorkspace } from "./workspaces.js";

/** Respuestas que no cambian por reintentar: el enlace no existe, ya no sirve o está mal formado. */
const FINAL = new Set(["gone", "not_found", "invalid_request"]);

/** @typedef {{ tenant: { id: string, name: string }, role: import("./workspaces.js").Role }} Preview */

/**
 * ¿Hay una invitación pendiente que mostrar? No consume nada.
 * @param {{ baseUrl: string, access: { mode: string }, token: string | null, storage: Pick<Storage, "removeItem"> | null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ state: "none" } | { state: "confirm", token: string, preview: Preview } | { state: "gone" } | { state: "unreachable" } | { state: "unavailable" }>}
 */
export async function checkPendingInvite({ baseUrl, access, token, storage, fetchImpl }) {
  if (token === null) return { state: "none" };
  if (access.mode === "key") {
    clearInvite(storage); // instalación local: no hay personas ni equipos a los que unirse
    return { state: "unavailable" };
  }
  if (access.mode !== "session") return { state: "none" }; // sin sesión el token espera al viaje de inicio de sesión
  try {
    const preview = await previewInvite({ baseUrl, token, fetchImpl });
    return { state: "confirm", token, preview };
  } catch (error) {
    if (error instanceof ApiError && FINAL.has(error.code)) {
      clearInvite(storage);
      return { state: "gone" };
    }
    return { state: "unreachable" }; // el token se conserva: recargar la página reintenta
  }
}

/**
 * El clic explícito: acepta y, solo entonces, abre ese espacio. Si aceptar sale bien pero no se puede abrir el espacio, la persona
 * ya es miembro: se avisa con `switched: false` en vez de decir que la invitación falló.
 * @param {{ baseUrl: string, token: string, storage: Pick<Storage, "removeItem"> | null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ outcome: "joined", tenant: { id: string, name: string }, role: string, switched: boolean } | { outcome: "gone" } | { outcome: "retry" }>}
 */
export async function acceptPendingInvite({ baseUrl, token, storage, fetchImpl }) {
  let joined;
  try {
    joined = await acceptInvite({ baseUrl, token, fetchImpl });
  } catch (error) {
    if (error instanceof ApiError && FINAL.has(error.code)) {
      clearInvite(storage);
      return { outcome: "gone" };
    }
    return { outcome: "retry" }; // el servidor deshizo la transacción o no la vio: el token sigue valiendo
  }
  clearInvite(storage);
  let switched = true;
  try {
    await switchWorkspace({ baseUrl, tenantId: joined.tenant.id, fetchImpl });
  } catch {
    switched = false;
  }
  return { outcome: "joined", tenant: joined.tenant, role: joined.role, switched };
}
