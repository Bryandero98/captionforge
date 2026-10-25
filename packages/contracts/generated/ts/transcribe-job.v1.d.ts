/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * Payload de la cola captionforge.transcribe (NestJS lo encola, el worker Python lo consume).
 */
export interface TranscribeJob {
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
  input: {
    /**
     * Nombre de bucket S3: 3-63 caracteres, minúsculas, dígitos, punto o guion.
     */
    bucket: string;
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    objectKey: string;
    /**
     * Solo informativo (nombre que subió el usuario); nunca se usa para construir rutas.
     */
    originalFilename: string;
    contentType:
      | "video/mp4"
      | "video/quicktime"
      | "video/x-matroska"
      | "video/webm"
      | "video/x-msvideo"
      | "video/x-m4v"
      | "video/3gpp"
      | "video/mpeg"
      | "video/x-ms-wmv"
      | "video/x-flv"
      | "video/ogg"
      | "audio/mpeg"
      | "audio/mp3"
      | "audio/wav"
      | "audio/x-wav"
      | "audio/wave"
      | "audio/mp4"
      | "audio/x-m4a"
      | "audio/m4a"
      | "audio/ogg"
      | "audio/flac"
      | "audio/x-flac"
      | "audio/opus"
      | "audio/aac"
      | "audio/x-aac"
      | "audio/amr"
      | "audio/x-ms-wma"
      | "audio/aiff"
      | "audio/x-aiff"
      | "audio/webm";
    sizeBytes: number;
  };
  /**
   * Prefijo de salida: jobs/<jobId>/ seguido de carpetas opcionales; siempre termina en '/'.
   */
  outputPrefix: string;
  options: {
    modelSize: "base" | "small" | "medium";
    /**
     * null = autodetectar.
     */
    sourceLanguage: string | null;
    /**
     * null = sin traducción.
     */
    translateTo: string | null;
    /**
     * Aislar la voz (Demucs) antes de transcribir. Opcional: si falta, false. Si la separación falla, el trabajo sigue con el audio original (ver audioCleaned en el resultado).
     */
    cleanAudio?: boolean;
    /**
     * Identificar quién habla (pyannote) y poner `speaker` en cada segmento. Opcional: si falta, false. Si falla o falta el token de Hugging Face, el trabajo sigue sin hablantes (ver diarized en el resultado).
     */
    diarize?: boolean;
  };
}
