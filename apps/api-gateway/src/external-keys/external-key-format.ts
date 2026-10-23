import type { ExternalProvider } from "./external-key-crypto.js";

/** Tope de longitud antes de cualquier otra comprobación: un cuerpo enorme no debe costar CPU ni acabar cifrado. */
export const MAX_EXTERNAL_KEY_LENGTH = 512;
const MIN_EXTERNAL_KEY_LENGTH = 20;
/** ASCII imprimible sin espacios: una clave de API de un proveedor no tiene nada más. */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

const PROVIDER_FORMAT: Record<ExternalProvider, RegExp> = {
  // sk-… (también sk-proj-…, con guiones y guiones bajos).
  openai: /^sk-[A-Za-z0-9_-]{17,}$/,
  elevenlabs: /^[A-Za-z0-9_-]{20,}$/,
};

/**
 * Devuelve la clave limpia (sin espacios ni saltos de línea en los extremos, el error típico al pegar) o `undefined` si no tiene el
 * formato del proveedor. Quien llama NO debe repetir el valor recibido en ningún mensaje.
 */
export function normalizeExternalKey(provider: ExternalProvider, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_EXTERNAL_KEY_LENGTH + 16) return undefined;
  const key = raw.trim();
  if (key.length < MIN_EXTERNAL_KEY_LENGTH || key.length > MAX_EXTERNAL_KEY_LENGTH) return undefined;
  if (!PRINTABLE_ASCII.test(key) || !PROVIDER_FORMAT[provider].test(key)) return undefined;
  return key;
}
