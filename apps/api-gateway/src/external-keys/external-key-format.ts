import type { ExternalProvider } from "./external-key-crypto.js";

/** Tope de longitud antes de cualquier otra comprobación: un cuerpo enorme no debe costar CPU ni acabar cifrado. */
export const MAX_EXTERNAL_KEY_LENGTH = 512;
const MIN_EXTERNAL_KEY_LENGTH = 20;
/** Con URL base propia la clave es de otro servicio (Ollama ni la valida): se pide solo lo mínimo para que no sea un descuido. */
const MIN_CUSTOM_KEY_LENGTH = 8;
/** ASCII imprimible sin espacios: una clave de API de un proveedor no tiene nada más. */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

const PROVIDER_FORMAT: Record<ExternalProvider, RegExp> = {
  // sk-… (también sk-proj-…, con guiones y guiones bajos).
  openai: /^sk-[A-Za-z0-9_-]{17,}$/,
  elevenlabs: /^[A-Za-z0-9_-]{20,}$/,
};

/** Nombre de modelo: letras, números y . _ : / @ + - (p. ej. `llama3.1:8b`, `meta-llama/Llama-3.3-70B-Instruct`); empieza por letra o número. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;

/** Devuelve el nombre de modelo limpio o `undefined` si no es válido. Quien llama NO debe repetir el valor recibido. */
export function normalizeModelName(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 200) return undefined;
  const model = raw.trim();
  return MODEL_NAME.test(model) && !model.includes("..") ? model : undefined;
}

/**
 * Devuelve la clave limpia (sin espacios ni saltos de línea en los extremos, el error típico al pegar) o `undefined` si no tiene el
 * formato del proveedor. Quien llama NO debe repetir el valor recibido en ningún mensaje.
 */
export function normalizeExternalKey(provider: ExternalProvider, raw: unknown, { custom = false }: { custom?: boolean } = {}): string | undefined {
  // `custom` (ADR 0022): OpenAI con URL base propia admite la clave de cualquier servicio compatible (Gemini, Groq, Claude...).
  const anyService = custom && provider === "openai";
  if (typeof raw !== "string" || raw.length > MAX_EXTERNAL_KEY_LENGTH + 16) return undefined;
  const key = raw.trim();
  if (key.length < (anyService ? MIN_CUSTOM_KEY_LENGTH : MIN_EXTERNAL_KEY_LENGTH) || key.length > MAX_EXTERNAL_KEY_LENGTH) return undefined;
  if (!PRINTABLE_ASCII.test(key) || (!anyService && !PROVIDER_FORMAT[provider].test(key))) return undefined;
  return key;
}
