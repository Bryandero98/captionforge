import { isIPv4, isIPv6 } from "node:net";

/**
 * URL base propia de un proveedor de IA (ADR 0022). Es lo único que decide a qué servidor viaja la clave del espacio, así que la
 * validación es estricta y está aquí, en una función pura que el API usa al guardar y que se puede probar por tablas y propiedades.
 * El worker vuelve a comprobar la dirección ya resuelta (DNS) justo antes de usarla.
 *
 * Con `allowPrivate` (la bandera ALLOW_PRIVATE_BASE_URLS, apagada por defecto) también se aceptan servidores locales o de la red
 * privada, por http o https, para quien usa Ollama o vLLM. Aun así nunca se aceptan los metadatos de nube (169.254.0.0/16), el enlace
 * local, las direcciones sin especificar, multidifusión ni reservadas.
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

export interface ParseOptions {
  /** ALLOW_PRIVATE_BASE_URLS: acepta hosts locales y privados (también por http). Por defecto no. */
  allowPrivate?: boolean;
}

/** `public`: dirección de Internet. `private`: red local (se permite solo con la bandera). `forbidden`: nunca. */
export type AddressClass = "public" | "private" | "forbidden";

/** Octetos de una IPv4 ya validada con `isIPv4`. */
const octets = (address: string): [number, number, number, number] => address.split(".").map(Number) as [number, number, number, number];

function classifyIPv4(address: string): AddressClass {
  const [a, b, c] = octets(address);
  if (a === 0 || a >= 224) return "forbidden"; // sin especificar, multidifusión, reservada y difusión
  if (a === 169 && b === 254) return "forbidden"; // enlace local y metadatos de nube
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "forbidden"; // protocolo IETF y TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return "forbidden"; // pruebas de rendimiento
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "forbidden"; // TEST-NET-2 y 3
  if (a === 10 || a === 127) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  return "public";
}

/** Los 32 bits más altos de una IPv6 ya validada con `isIPv6`, como dos grupos de 16 bits. */
function ipv6Head(address: string): [number, number] {
  const [head = ""] = address.split("%")[0]!.split("::");
  const groups = head === "" ? [] : head.split(":");
  const first = groups.length > 0 ? Number.parseInt(groups[0]!, 16) : 0;
  const second = groups.length > 1 ? Number.parseInt(groups[1]!, 16) : 0;
  return [Number.isNaN(first) ? 0 : first, Number.isNaN(second) ? 0 : second];
}

function classifyIPv6(address: string): AddressClass {
  const [first, second] = ipv6Head(address);
  const lower = address.toLowerCase();
  if (lower === "::1") return "private";
  if (first >= 0xfc00 && first <= 0xfdff) return "private"; // local única (fc00::/7)
  // Todo lo demás que no sea unicast global (2000::/3) es especial: sin especificar, enlace local, multidifusión, IPv4 mapeada, NAT64...
  if (first < 0x2000 || first > 0x3fff) return "forbidden";
  if (first === 0x2001 && (second === 0x0db8 || second === 0)) return "forbidden"; // documentación y Teredo
  if (first === 0x2002) return "forbidden"; // 6to4: lleva una IPv4 dentro
  return "public";
}

/** Clasifica una dirección IP. Cualquier texto que no sea una IP es `forbidden`. */
export function classifyAddress(address: string): AddressClass {
  if (isIPv4(address)) return classifyIPv4(address);
  if (isIPv6(address)) return classifyIPv6(address);
  return "forbidden";
}

/** ¿Es una dirección IP de Internet pública? Cualquier otra cosa (privada, de bucle, enlace local, metadatos, reservada o texto) es no. */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === "public";
}

const isLocalName = (hostname: string): boolean =>
  !hostname.includes(".") || LOCAL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));

/**
 * Devuelve la URL normalizada o `undefined` si no es aceptable. Por defecto acepta solo `https:` con un NOMBRE de host público (nunca
 * una IP, ni en decimal, hexadecimal o abreviada: el analizador de URL las convierte y se rechazan), sin credenciales, consulta ni
 * fragmento. Quien llama NO debe repetir el valor recibido en ningún mensaje.
 */
export function parseBaseUrl(raw: unknown, { allowPrivate = false }: ParseOptions = {}): ParsedBaseUrl | undefined {
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
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return undefined;
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(url.pathname) || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(text.slice(text.indexOf("//") + 2))) return undefined;

  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (hostname === "") return undefined;
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const isLiteral = isIPv4(bare) || isIPv6(bare);

  let local: boolean;
  if (isLiteral) {
    // Una IP literal solo se acepta con la bandera y solo si es de la red local (nunca pública ni prohibida).
    if (!allowPrivate || classifyAddress(bare) !== "private") return undefined;
    local = true;
  } else {
    local = isLocalName(hostname);
    if (local && !allowPrivate) return undefined;
    if (!local) {
      const tld = hostname.slice(hostname.lastIndexOf(".") + 1);
      if (/^[0-9]+$/.test(tld) || tld.length < 2) return undefined; // "1.2.3.4" disfrazada o un TLD que no existe
    }
  }
  // Sin cifrar solo cuando el servidor es local: un servidor público exige https.
  if (url.protocol === "http:" && !local) return undefined;

  const host = url.port === "" ? hostname : `${hostname}:${url.port}`;
  const path = url.pathname.replace(/\/+$/, "");
  return { url: `${url.protocol}//${host}${path}`, host };
}
