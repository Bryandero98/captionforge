/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * returnvalue del trabajo de quemado de subtítulos.
 */
export interface BurnResult {
  schemaVersion: 1;
  jobId: string;
  /**
   * false si se pidió karaoke pero ningún segmento conservaba tiempos por palabra.
   */
  usedKaraoke: boolean;
  artifacts: {
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    video: string;
  };
}
