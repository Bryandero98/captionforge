// Opciones del quemado que la interfaz sabe dibujar. Son las del contrato `burn-job.v1.json` (una prueba del servidor compara las plantillas
// con el esquema); viven en el dominio para que la capa de red y la de pantalla las compartan sin depender una de otra.

export const BURN_STYLES = /** @type {const} */ (["modern", "tiktok", "youtube", "minimal"]);
/** Plantillas de subtítulos dinámicos del formato vertical. */
export const BURN_TEMPLATES = /** @type {const} */ (["bold-pop", "rounded-sweep", "clean-color"]);
/** Tope del formato vertical si el servidor no lo anuncia (el mismo valor por defecto del API y del worker). */
export const DEFAULT_VERTICAL_MAX_SECONDS = 600;
/** Mayor tope que se acepta de un servidor: un día. Más allá es un dato roto. */
export const MAX_VERTICAL_MAX_SECONDS = 86_400;
