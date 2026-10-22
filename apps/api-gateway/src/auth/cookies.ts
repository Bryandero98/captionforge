// Cookies a mano (sin dependencias): solo hacen falta dos, la de sesión y la del intento de inicio de sesión en curso.

/** Valor de una cookie del encabezado `Cookie`, o undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

/**
 * `Set-Cookie` con HttpOnly, SameSite=Lax y Path=/. Lax y no Strict: la cookie tiene que viajar en la navegación de vuelta
 * desde GitHub o Google (una petición GET de primer nivel de otro sitio). Con Secure se usa el prefijo `__Host-`, que el
 * navegador solo acepta si la cookie es Secure, sin Domain y con Path=/ (no la puede fijar un subdominio vecino).
 */
export function setCookie(name: string, value: string, { maxAgeSeconds, secure }: CookieOptions): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const clearCookie = (name: string, secure: boolean): string => setCookie(name, "", { maxAgeSeconds: 0, secure });

export const SESSION_COOKIE = "cf_session";
export const OAUTH_COOKIE = "cf_oauth";

/** Nombre real de la cookie: con Secure lleva el prefijo `__Host-`. */
export const cookieName = (base: string, secure: boolean): string => (secure ? `__Host-${base}` : base);
