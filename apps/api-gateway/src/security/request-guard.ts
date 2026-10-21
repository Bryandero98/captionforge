/**
 * Defensa del API frente a páginas web ajenas que actúan desde el navegador de quien lo usa (H10).
 *
 * El API no usa cookies ni sesiones, así que un token anti-CSRF no protegería nada: ese token defiende
 * credenciales que el navegador envía solo. Lo que sí está expuesto, sobre todo sin `API_KEY` en
 * 127.0.0.1, es:
 *   - CSRF por petición simple: un `POST multipart/form-data` cross-origin no necesita preflight y
 *     cualquier página abierta puede crear, cancelar o quemar trabajos.
 *   - DNS rebinding: un dominio atacante que resuelve a 127.0.0.1 hace que el navegador lo trate como
 *     mismo origen y deja leer las respuestas.
 *
 * Reglas (todas fail-closed, funciones puras para poder probarlas a fondo):
 *   1. `Host` debe estar en ALLOWED_HOSTS (421 si no). Frena el rebinding.
 *   2. Si hay `Origin`, debe estar en ALLOWED_ORIGINS o ser el propio origen del API (403 si no). Un
 *      navegador siempre lo envía en un POST/PUT y una página no puede falsificarlo; los clientes que no
 *      son navegadores (curl, otros servicios) no lo envían y no se ven afectados.
 *   3. Sin `Origin`, una petición que modifica y llega marcada `Sec-Fetch-Site: cross-site|same-site`
 *      se rechaza (403): segunda línea de defensa por si algún cliente omite `Origin`.
 */

export type Policy = {
  allowedOrigins: readonly string[];
  allowedHosts: readonly string[];
};

export type RequestInfo = {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
};

export type Verdict = { status: 403 | 421; message: string } | null;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Nombre DNS o IPv4 (letras, dígitos, puntos y guiones, sin punto final) o IPv6 entre corchetes.
const HOSTNAME = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/;

/**
 * Nombre de host de una cabecera `Host`, en minúsculas y sin puerto. `undefined` si la cabecera falta o
 * está malformada (espacios, `@`, `/`, punto final...): una cabecera rara es motivo de rechazo, no de
 * adivinar qué quiso decir.
 */
export function hostnameOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().toLowerCase();
  if (value === "") return undefined;
  const bracketed = /^(\[[^\]]*\])(?::(\d{1,5}))?$/.exec(value);
  const plain = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  const name = bracketed?.[1] ?? plain?.[1];
  if (name === undefined || !HOSTNAME.test(name)) return undefined;
  return name;
}

/** `Origin` normalizado (esquema y host en minúsculas, sin puerto por defecto), o undefined si no es un origen http(s). */
function normalizeOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") return undefined;
    // Un Origin válido no lleva ruta, parámetros ni credenciales.
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return undefined;
    if (origin.replace(/\/$/, "").toLowerCase() !== url.origin && origin.toLowerCase() !== url.origin) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Resumen de una línea de lo que se acepta, para el registro de arranque: la política efectiva queda a la vista. */
export function describePolicy(policy: Policy): string {
  const origins = policy.allowedOrigins.length > 0 ? policy.allowedOrigins.join(", ") : "ninguno (solo mismo origen)";
  return `hosts: ${policy.allowedHosts.join(", ")}; orígenes de navegador: ${origins}`;
}

export function evaluate(info: RequestInfo, policy: Policy): Verdict {
  const site = info.secFetchSite?.toLowerCase();
  const fromAnotherSite = site === "cross-site" || site === "same-site";
  const method = info.method.toUpperCase();

  // Los sondeos de salud del orquestador llegan con el Host del pod o del balanceador. Solo se eximen los
  // sondeos reales (GET o HEAD sin Origin ni marca de otro sitio): una página ajena con <img src="…/health">
  // sí envía Sec-Fetch-Site y no debe poder lanzar consultas a la base de datos, Redis y S3.
  const isHealth = info.path.split("?")[0] === "/health";
  if (isHealth && info.origin === undefined && !fromAnotherSite && (method === "GET" || method === "HEAD")) return null;

  const hostname = hostnameOf(info.host);
  if (hostname === undefined || !policy.allowedHosts.includes(hostname)) {
    return { status: 421, message: "Host no permitido." };
  }

  if (info.origin !== undefined) {
    const origin = normalizeOrigin(info.origin);
    const allowed = origin !== undefined && (policy.allowedOrigins.includes(origin) || new URL(origin).host === info.host?.trim().toLowerCase());
    return allowed ? null : { status: 403, message: "Origen no permitido." };
  }

  // Las lecturas de otro sitio (enlaces, descargas) pasan; las que modifican y /health no.
  if ((isHealth || !SAFE_METHODS.has(method)) && fromAnotherSite) {
    return { status: 403, message: "Petición de otro sitio no permitida." };
  }
  return null;
}
