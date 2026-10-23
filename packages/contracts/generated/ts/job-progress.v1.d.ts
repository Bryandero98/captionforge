/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Valor que el worker pasa a job.updateProgress() y refleja en PostgreSQL.
 */
export interface JobProgress {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  stage:
    | "downloading_input"
    | "extracting_audio"
    | "downloading_separation_model"
    | "separating_voice"
    | "downloading_model"
    | "transcribing"
    | "downloading_diarization_model"
    | "diarizing"
    | "translating"
    | "uploading"
    | "burning"
    | "synthesizing"
    | "mixing";
  percent: number;
  message: string;
}
