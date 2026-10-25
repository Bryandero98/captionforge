/* eslint-disable */
/**
 * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.
 * Regenerar con: npm run contracts:gen
 */

/**
 * returnvalue del trabajo de quemado de subtítulos.
 */
export interface BurnResult {
  /**
   * Siempre 1 en este esquema.
   */
  schemaVersion: number;
  /**
   * UUID en minúsculas con guiones (la forma que produce randomUUID() y uuid() de Prisma).
   */
  jobId: string;
  /**
   * false si se pidió karaoke pero ningún segmento conservaba tiempos por palabra.
   */
  usedKaraoke: boolean;
  /**
   * Segmentos cuyo texto se editó y cuyos tiempos por palabra se repartieron de forma aproximada (alineación difflib).
   */
  approximateSegments?: number;
  artifacts: {
    /**
     * Clave dentro de jobs/<jobId>/. Solo [A-Za-z0-9_-] por segmento y un punto de extensión opcional en el último: no admite '..', barras iniciales ni rutas absolutas (sin lookahead, para que Pydantic y Ajv validen igual).
     */
    video: string;
  };
}
