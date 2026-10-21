/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Valor que el worker pasa a job.updateProgress() y refleja en PostgreSQL.
 */
export interface JobProgress {
  schemaVersion: 1;
  stage:
    | "downloading_input"
    | "extracting_audio"
    | "downloading_model"
    | "transcribing"
    | "translating"
    | "uploading"
    | "burning";
  percent: number;
  message: string;
}
