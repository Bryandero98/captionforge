import { isIPv4, isIPv6 } from "node:net";

/**
 * URL base propia de un proveedor de IA (ADR 0022). Es lo único que decide a qué servidor viaja la clave del espacio, así que la
 * validación es estricta y está aquí, en una función pura que el API usa al guardar y que se puede probar por tablas y propiedades.
 * El worker vuelve a comprobar la dirección ya resuelta (DNS) justo antes de usarla.
 */

/** Tope de longitud, antes de cualquier otra comprobación. */
export const MAX_BASE_URL_LENGTH = 2048;

/** Terminaciones de nombre que solo existen en redes locales o privadas. */
const LOCAL_SUFFIXES = ["localhost", "local", "localdomain", "internal", "lan", "home", "corp", "intranet", "private", "home.arpa", "in-addr.arpa", "ip6.arpa"];

export interface ParsedBaseUrl {
  /** Forma normalizada, sin barra final: es la que se cifra y se usa. */
  url: string;
  /** Solo el host (con puerto si no es el 443): lo único que se muestra. */
  host: string;
}

/**
 * Devuelve la URL normalizada o `undefined` si no es aceptable. Acepta solo `https:` con un NOMBRE de host público (nunca una IP, ni en
 * decimal, hexadecimal o abreviada: el analizador de URL las convierte y se rechazan), sin credenciales, consulta ni fragmento.
 * Quien llama NO debe repetir el valor recibido en ningún mensaje.
 */
export function parseBaseUrl(raw: unknown): ParsedBaseUrl | undefined {
  if (typeof raw !== "string" || raw.length > MAX_BASE_URL_LENGTH + 16) return undefined;
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_BASE_URL_LENGTH) return undefined;
  // Espacios, controles y barra invertida (que algunos analizadores tratan como "/") no tienen sitio en una URL de API.
  if (/[\s\u0000-\u001f\u007f\\]/.test(text) || text.includes("?") || text.includes("#")) return undefined;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(url.pathname) || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(text.slice(text.indexOf("//") + 2))) return undefined;

  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (hostname === "" || hostname.startsWith("[") || isIPv4(hostname) || isIPv6(hostname)) return undefined;
  if (!hostname.includes(".")) return undefined; // "intranet", "localhost": nombres de una sola etiqueta
  if (LOCAL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) return undefined;
  const tld = hostname.slice(hostname.lastIndexOf(".") + 1);
  if (/^[0-9]+$/.test(tld) || tld.length < 2) return undefined; // "1.2.3.4" disfrazada o un TLD que no existe

  const host = url.port === "" ? hostname : `${hostname}:${url.port}`;
  const path = url.pathname.replace(/\/+$/, "");
  return { url: `https://${host}${path}`, host };
}

/** Octetos de una IPv4 ya validada con `isIPv4`. */
const octets = (address: string): number[] => address.split(".").map(Number);

function isPublicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = octets(address) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // enlace local y metadatos de nube
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocolo IETF y TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // pruebas de rendimiento
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Los 16 bits más altos de una IPv6 ya validada con `isIPv6` (y sus dos siguientes), o undefined si no se pueden leer. */
function ipv6Head(address: string): [number, number] | undefined {
  const withoutZone = address.split("%")[0]!;
  const [head = ""] = withoutZone.split("::");
  const groups = head === "" ? [] : head.split(":");
  const first = groups.length > 0 ? Number.parseInt(groups[0]!, 16) : 0;
  const second = groups.length > 1 ? Number.parseInt(groups[1]!, 16) : 0;
  return Number.isNaN(first) || Number.isNaN(second) ? undefined : [first, second];
}

function isPublicIPv6(address: string): boolean {
  if (!isIPv6(address)) return false;
  const head = ipv6Head(address);
  if (head === undefined) return false;
  const [first, second] = head;
  // Solo el unicast global (2000::/3). Quedan fuera ::, ::1, ::ffff:a.b.c.d, fc00::/7, fe80::/10, ff00::/8 y 64:ff9b::/96.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second === 0x0db8 || second === 0)) return false; // documentación y Teredo
  if (first === 0x2002) return false; // 6to4: lleva una IPv4 dentro
  return true;
}

/** ¿Es una dirección IP de Internet pública? Cualquier otra cosa (privada, de bucle, enlace local, metadatos, reservada o texto) es no. */
export function isPublicAddress(address: string): boolean {
  return isPublicIPv4(address) || isPublicIPv6(address);
}
