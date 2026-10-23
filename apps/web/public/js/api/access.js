// Cómo entra esta página al API (ADR 0016), decidido una vez al cargar:
//  - "key":     instalación local (o una clave guardada en este navegador): la clave por defecto va en cada petición.
//  - "session": la persona ya inició sesión (cookie): el API la reconoce solo.
//  - "login":   sin clave ni sesión y con proveedores configurados: hay que entrar con GitHub o Google.
//  - "none":    sin clave, sin sesión y sin proveedores: no hay forma de entrar (configuración del servidor).
//  - "error":   no se pudo comprobar (el servidor no responde).

import { getMe, getProviders } from "./account.js";
import { loadApiKey, setSessionMode } from "./auth.js";

/** @typedef {{ mode: "key" | "session" | "login" | "none" | "error", providers: string[], me: import("./account.js").Me | null }} Access */

/**
 * @param {{ baseUrl: string, storage?: Pick<Storage, "getItem"> | null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Access>}
 */
export async function resolveAccess({ baseUrl, storage = null, fetchImpl }) {
  if ((await loadApiKey({ baseUrl, storage, fetchImpl })) !== "none") return { mode: "key", providers: [], me: null };
  const providers = await getProviders({ baseUrl, fetchImpl });
  setSessionMode(true);
  try {
    return { mode: "session", providers, me: await getMe({ baseUrl, fetchImpl }) };
  } catch (error) {
    setSessionMode(false);
    if (/** @type {{ code?: string }} */ (error)?.code === "unauthorized") return { mode: providers.length > 0 ? "login" : "none", providers, me: null };
    return { mode: "error", providers, me: null };
  }
}
