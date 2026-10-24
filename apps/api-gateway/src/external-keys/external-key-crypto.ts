import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** Proveedores externos de v1 (ADR 0020). Argos es local y no usa clave. */
export const EXTERNAL_PROVIDERS = ["openai", "elevenlabs"] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export const isExternalProvider = (value: unknown): value is ExternalProvider =>
  typeof value === "string" && (EXTERNAL_PROVIDERS as readonly string[]).includes(value);

/** Versión de la clave de cifrado de la fila (`keyVersion`): hoy solo la 1; la rotación de APP_SECRET queda para un issue futuro. */
export const CURRENT_KEY_VERSION = 1;
/** Mínimo de APP_SECRET, en bytes. */
export const MIN_APP_SECRET_BYTES = 32;

/** Con menos de 20 caracteres, 4 serían más de la quinta parte de la clave. */
export const MIN_HINT_KEY_LENGTH = 20;

const FORMAT = "v1";
const IV_BYTES = 12; // 96 bits, el tamaño que GCM maneja sin pasos extra
const TAG_BYTES = 16; // 128 bits
const HKDF_INFO = "captionforge/external-key/v1";

/** Lo que ata un cifrado a su fila: copiarlo a otro espacio, otro proveedor u otra versión lo vuelve indescifrable. */
export interface KeyContext {
  tenantId: string;
  provider: ExternalProvider;
  keyVersion: number;
}

/** Fallo al descifrar. El mensaje es genérico a propósito: nunca incluye el texto, el valor guardado ni el secreto. */
export class ExternalKeyDecryptError extends Error {
  constructor() {
    super("No se pudo descifrar la clave externa.");
    this.name = "ExternalKeyDecryptError";
  }
}

const aad = (ctx: KeyContext): Buffer => Buffer.from(`${ctx.tenantId}|${ctx.provider}|${ctx.keyVersion}`, "utf8");

/**
 * AES-256-GCM con la clave derivada de APP_SECRET por HKDF-SHA256 (el secreto crudo nunca es la clave). Cada cifrado usa un IV
 * aleatorio de 96 bits y autentica el contexto (`tenantId|provider|keyVersion`) como dato adicional.
 * Formato guardado: `v1.<iv>.<etiqueta>.<datos>` en base64url.
 */
export class ExternalKeyCipher {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    if (Buffer.byteLength(appSecret, "utf8") < MIN_APP_SECRET_BYTES) {
      throw new Error(`APP_SECRET debe tener al menos ${MIN_APP_SECRET_BYTES} bytes`);
    }
    // Sin sal: el secreto ya es aleatorio y largo, y la sal fija haría las claves derivadas dependientes de otro valor a conservar.
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(appSecret, "utf8"), Buffer.alloc(0), HKDF_INFO, 32));
  }

  encrypt(plaintext: string, ctx: KeyContext): string {
    if (plaintext === "") throw new Error("No se cifra un texto vacío.");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(ctx));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  }

  decrypt(stored: string, ctx: KeyContext): string {
    const parts = stored.split(".");
    if (parts.length !== 4 || parts[0] !== FORMAT) throw new ExternalKeyDecryptError();
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const data = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || data.length === 0) throw new ExternalKeyDecryptError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(ctx));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      throw new ExternalKeyDecryptError(); // la causa original (de OpenSSL) no se propaga: no aporta y podría filtrar detalle
    }
  }
}

/** Últimos 4 caracteres para reconocer la clave en la interfaz. Una clave corta no se muestra: devuelve "". */
export const keyHint = (key: string): string => (key.length >= MIN_HINT_KEY_LENGTH ? key.slice(-4) : "");
