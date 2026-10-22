import { createHash, randomBytes } from "node:crypto";

/** Prefijo legible de las claves: sirve para reconocerlas en un .env o en un registro, no para autenticar. */
export const API_KEY_PREFIX = "cfk_";
/** Cuántos caracteres de la clave se guardan en claro para identificarla en listados (incluye el prefijo). */
export const DISPLAY_PREFIX_LENGTH = 8;
/** Id fijo del tenant que crea la migración y al que pasan los trabajos que ya existían (ADR 0015). */
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";
/** Tope de longitud antes de calcular el hash: una cabecera enorme no debe costar CPU. */
export const MAX_API_KEY_LENGTH = 256;

/**
 * SHA-256 hexadecimal de la clave. La base solo guarda esto: un volcado de la tabla no da claves utilizables.
 * Un hash rápido basta porque las claves son aleatorias de 256 bits (no hay diccionario que recorrer, a diferencia
 * de una contraseña); bcrypt/argon2 solo añadirían latencia a cada petición.
 */
export const hashApiKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

export const displayPrefix = (key: string): string => key.slice(0, DISPLAY_PREFIX_LENGTH);

/** Clave nueva: `cfk_` + 256 bits aleatorios en hexadecimal. */
export const generateApiKey = (): string => API_KEY_PREFIX + randomBytes(32).toString("hex");
