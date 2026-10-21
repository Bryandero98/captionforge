/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Error estructurado que el worker guarda en PostgreSQL (y serializa en failedReason).
 */
export interface JobError {
  schemaVersion: 1;
  jobId: string;
  errorCode:
    | "FFMPEG_FAILED"
    | "FFMPEG_TIMEOUT"
    | "MODEL_DOWNLOAD_FAILED"
    | "OUT_OF_DISK"
    | "INPUT_NOT_FOUND"
    | "SEGMENTS_CHANGED"
    | "CANCELLED"
    | "INTERNAL";
  /**
   * Texto legible para el usuario; sin rutas internas ni credenciales.
   */
  message: string;
}
