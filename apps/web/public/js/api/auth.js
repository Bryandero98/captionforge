// Clave de API de la interfaz (ADR 0015). Cada petición del cliente (fetch, XMLHttpRequest, SSE) lleva `X-API-Key`.
//
// El MVP no tiene inicio de sesión: la clave por defecto la configura quien despliega (DEFAULT_API_KEY en el .env) y el
// servidor la entrega a la propia interfaz en GET /web-config.json, solo al mismo origen (la guardia de Host/Origin
// impide que una página ajena la lea). Una clave guardada en este navegador (localStorage "cf-api-key") tiene prioridad:
// sirve para usar otra clave sin tocar el servidor. El inicio de sesión de personas (issue #7) sustituye todo esto.

export const STORAGE_KEY = "cf-api-key";
const MAX_KEY_LENGTH = 256;
const REQUEST_TIMEOUT_MS = 10_000;

let apiKey = "";

/** Fija la clave que llevarán las peticiones. Vacía o inválida = ninguna. @param {unknown} key */
export function setApiKey(key) {
  apiKey = typeof key === "string" && key.trim() !== "" && key.trim().length <= MAX_KEY_LENGTH && !/[\s\u0000-\u001f]/.test(key.trim()) ? key.trim() : "";
}

export const hasApiKey = () => apiKey !== "";

/**
 * Cabeceras de autenticación de la sesión actual (vacío si no hay clave).
 * @returns {Record<string, string>}
 */
export function authHeaders() {
  return apiKey === "" ? {} : { "X-API-Key": apiKey };
}

/**
 * Busca la clave: primero la guardada en el navegador, luego la del servidor. Nunca lanza: sin clave, el API responde 401
 * y la interfaz lo muestra con su mensaje normal.
 * @param {{ baseUrl: string, storage?: Pick<Storage, "getItem"> | null, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<"storage" | "server" | "none">}
 */
export async function loadApiKey({ baseUrl, storage = null, signal, fetchImpl = (...args) => fetch(...args) }) {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (typeof stored === "string" && stored.trim() !== "") {
      setApiKey(stored);
      if (hasApiKey()) return "storage";
    }
  } catch {
    // localStorage puede lanzar (modo privado, datos bloqueados): se sigue con la del servidor.
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/web-config.json`, { cache: "no-store", headers: { Accept: "application/json" }, signal: timeout.signal });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return "none";
    const data = /** @type {{ apiKey?: unknown } | null} */ (await response.json());
    setApiKey(data?.apiKey);
    return hasApiKey() ? "server" : "none";
  } catch {
    return "none";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
