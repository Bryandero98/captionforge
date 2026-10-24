/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Payload de la cola captionforge.translate: traduce segments.json conservando los tiempos. Nunca lleva claves externas: el worker las pide al API (ADR 0020).
 */
export interface TranslateJob {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  /**
   * UUID en minúsculas con guiones (la forma que produce randomUUID() y uuid() de Prisma).
   */
  jobId: string;
  /**
   * Fecha y hora ISO 8601 con zona obligatoria (Z o ±hh:mm); sin segundos intercalares. Se define solo por patrón (sin format: date-time) para que Ajv y Pydantic acepten exactamente lo mismo: Pydantic no puede aplicar un patrón a un datetime.
   */
  requestedAt: string;
  segments: VersionedObjectRef;
  /**
   * Prefijo de salida: jobs/<jobId>/ seguido de carpetas opcionales; siempre termina en '/'.
   */
  outputPrefix: string;
  options: {
    /**
     * Motor de traducción: argos corre en local (sin clave); el resto es un proveedor de IA de texto que usa la clave propia del espacio (ADR 0022).
     */
    provider:
      "argos" | "openai" | "deepseek" | "gemini" | "anthropic" | "groq" | "openrouter" | "abacus";
    /**
     * Código ISO 639-1 (o 639-3 de tres letras, como los que acepta Whisper).
     */
    sourceLanguage: string;
    /**
     * Código ISO 639-1 (o 639-3 de tres letras, como los que acepta Whisper).
     */
    targetLanguage: string;
  };
}
/**
 * segments.json de origen; el worker falla con SEGMENTS_CHANGED si su ETag ya no coincide.
 */
export interface VersionedObjectRef {
  /**
   * Nombre de bucket S3: 3-63 caracteres, minúsculas, dígitos, punto o guion.
   */
  bucket: string;
  /**
   * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
   */
  objectKey: string;
  etag: string;
}
