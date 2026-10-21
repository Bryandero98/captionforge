/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Payload de la cola captionforge.burn: quema subtítulos ya aprobados sobre el video original.
 */
export interface BurnJob {
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
  input: ObjectRef;
  segments: VersionedObjectRef;
  /**
   * Prefijo de salida: jobs/<jobId>/ seguido de carpetas opcionales; siempre termina en '/'.
   */
  outputPrefix: string;
  options: {
    style: "modern" | "tiktok" | "youtube" | "minimal";
    karaoke: boolean;
  };
}
export interface ObjectRef {
  /**
   * Nombre de bucket S3: 3-63 caracteres, minúsculas, dígitos, punto o guion.
   */
  bucket: string;
  /**
   * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
   */
  objectKey: string;
}
/**
 * segments.json aprobado; el worker falla con SEGMENTS_CHANGED si su ETag ya no coincide.
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
