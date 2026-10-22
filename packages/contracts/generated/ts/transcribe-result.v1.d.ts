/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * returnvalue del trabajo de transcripción.
 */
export interface TranscribeResult {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  /**
   * UUID en minúsculas con guiones (la forma que produce randomUUID() y uuid() de Prisma).
   */
  jobId: string;
  /**
   * Código ISO 639-1 (o 639-3 de tres letras, como los que acepta Whisper).
   */
  detectedLanguage: string;
  device: "cpu" | "cuda";
  durationSeconds: number;
  segmentCount: number;
  /**
   * true si se transcribió el audio con la voz aislada. false si no se pidió o si la separación falló y se usó el audio original. Si falta (resultados anteriores), false.
   */
  audioCleaned?: boolean;
  artifacts: {
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    srt: string;
    segments: VersionedObjectRef;
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    waveform: string;
  };
}
/**
 * Referencia con ETag: el worker verifica que el objeto no cambió desde que se aprobó.
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
