// Invitación pendiente (ADR 0019). El enlace llega como `/?invite=<token>`: se guarda en este navegador, se quita de la barra de
// direcciones (no se queda en el historial ni viaja en un Referer) y sobrevive al viaje a GitHub o Google y de vuelta, hasta que se
// consume o falla. El servidor es quien decide si sirve: el token de un solo uso y con vencimiento no es un secreto de larga vida.

export const INVITE_KEY = "cf_invite";
const TOKEN = /^cfi_[A-Za-z0-9_-]{43}$/;

/**
 * Toma `?invite=` de la URL actual, lo guarda y lo borra de la URL. Devuelve la invitación pendiente (nueva o ya guardada), o null.
 * @param {{ location: { search: string, pathname: string, hash: string }, history: { replaceState(state: unknown, title: string, url: string): void } }} win
 * @param {Pick<Storage, "getItem" | "setItem" | "removeItem"> | null} storage
 * @returns {string | null}
 */
export function captureInvite(win, storage) {
  /** @type {string | null} */
  let fresh = null;
  try {
    const params = new URLSearchParams(win.location.search);
    const fromUrl = params.get("invite");
    if (fromUrl !== null) {
      if (TOKEN.test(fromUrl)) fresh = fromUrl;
      params.delete("invite");
      const rest = params.toString();
      win.history.replaceState(null, "", `${win.location.pathname}${rest === "" ? "" : `?${rest}`}${win.location.hash}`);
    }
  } catch {
    // sin History API: el token queda en la barra de direcciones, pero se sigue usando
  }
  if (fresh !== null) {
    try {
      storage?.setItem(INVITE_KEY, fresh);
    } catch {
      // Sin almacenamiento (modo privado, datos bloqueados) la invitación vale en esta carga, pero no sobrevive al viaje a GitHub o
      // Google: tras iniciar sesión habrá que abrir el enlace otra vez.
    }
    return fresh;
  }
  return pendingInvite(storage);
}

/** ¿Trae la URL un `?invite=` que no tiene la forma de un token (enlace cortado al copiarlo)? Se mira ANTES de capturarlo. @param {{ location: { search: string } }} win */
export function brokenInviteInUrl(win) {
  try {
    const value = new URLSearchParams(win.location.search).get("invite");
    return value !== null && !TOKEN.test(value);
  } catch {
    return false;
  }
}

const JOINED_KEY = "cf_joined";

/** Recuerda «te uniste a X» durante la recarga que abre el espacio nuevo. @param {Pick<Storage, "setItem"> | null} storage @param {{ name: string, role: string }} joined */
export function rememberJoined(storage, joined) {
  try {
    storage?.setItem(JOINED_KEY, JSON.stringify({ name: joined.name, role: joined.role }));
  } catch {
    // sin almacenamiento: se entra igualmente, solo que sin el aviso
  }
}

/** Lee y borra el aviso de «te uniste a X». @param {Pick<Storage, "getItem" | "removeItem"> | null} storage @returns {{ name: string, role: string } | null} */
export function takeJoined(storage) {
  try {
    const raw = storage?.getItem(JOINED_KEY) ?? null;
    storage?.removeItem(JOINED_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    return typeof value?.name === "string" && typeof value?.role === "string" ? { name: value.name.slice(0, 200), role: value.role } : null;
  } catch {
    return null;
  }
}

/** @param {Pick<Storage, "getItem"> | null} storage @returns {string | null} */
export function pendingInvite(storage) {
  try {
    const value = storage?.getItem(INVITE_KEY) ?? null;
    return value !== null && TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** @param {Pick<Storage, "removeItem"> | null} storage */
export function clearInvite(storage) {
  try {
    storage?.removeItem(INVITE_KEY);
  } catch {
    // nada que borrar
  }
}
