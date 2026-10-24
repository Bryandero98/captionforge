/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * returnvalue del trabajo de doblaje.
 */
export interface DubResult {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  /**
   * UUID en minúsculas con guiones (la forma que produce randomUUID() y uuid() de Prisma).
   */
  jobId: string;
  /**
   * Motor de voz (texto a voz): siempre externo, con la clave propia del espacio.
   */
  provider: "openai" | "elevenlabs";
  /**
   * none: solo dub.mp3. replace: el video con la voz doblada en lugar del audio original. duck: el audio original bajado bajo la voz.
   */
  mix: "none" | "replace" | "duck";
  segmentCount: number;
  /**
   * Caracteres enviados a sintetizar (lo que cuenta para el gasto).
   */
  characters: number;
  /**
   * Índices de los segmentos cuya voz no cupo en su tiempo ni acelerando al tope; se recortó su silencio y aun así se desborda.
   *
   * @maxItems 1000
   */
  overflowSegments: number[];
  artifacts: {
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    audio: string;
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    video?: string;
  };
}
