/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Error estructurado que el worker guarda en PostgreSQL (y serializa en failedReason).
 */
export interface JobError {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  /**
   * UUID en minúsculas con guiones (la forma que produce randomUUID() y uuid() de Prisma).
   */
  jobId: string;
  errorCode:
    | "FFMPEG_FAILED"
    | "FFMPEG_TIMEOUT"
    | "MODEL_DOWNLOAD_FAILED"
    | "OUT_OF_DISK"
    | "INPUT_NOT_FOUND"
    | "SEGMENTS_CHANGED"
    | "EXTERNAL_KEY_MISSING"
    | "EXTERNAL_AUTH_FAILED"
    | "EXTERNAL_RATE_LIMITED"
    | "EXTERNAL_QUOTA_EXCEEDED"
    | "EXTERNAL_TIMEOUT"
    | "EXTERNAL_UNAVAILABLE"
    | "JOB_TOO_LARGE"
    | "CANCELLED"
    | "INTERNAL";
  /**
   * Texto legible para el usuario; sin rutas internas ni credenciales.
   */
  message: string;
}
