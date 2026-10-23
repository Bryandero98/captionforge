/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * returnvalue del trabajo de traducción.
 */
export interface TranslateResult {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  /**
   * UUID en minúsculas con guiones (la forma que produce randomUUID() y uuid() de Prisma).
   */
  jobId: string;
  /**
   * Motor de traducción: argos corre en local (sin clave); openai usa la clave propia del espacio.
   */
  provider: "argos" | "openai";
  /**
   * Código ISO 639-1 (o 639-3 de tres letras, como los que acepta Whisper).
   */
  sourceLanguage: string;
  /**
   * Código ISO 639-1 (o 639-3 de tres letras, como los que acepta Whisper).
   */
  targetLanguage: string;
  segmentCount: number;
  /**
   * Caracteres de texto enviados a traducir (lo que cuenta para el gasto).
   */
  characters: number;
  artifacts: {
    segments: VersionedObjectRef;
  };
}
/**
 * Segmentos traducidos, con los tiempos originales; el ETag permite doblarlos o quemarlos después sin que cambien.
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
