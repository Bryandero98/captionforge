// Límites del API que la interfaz comprueba antes de enviar (el servidor sigue siendo quien manda: ver
// apps/api-gateway/src/jobs/segments.ts).

/** Caracteres máximos del texto de un subtítulo. */
export const MAX_TEXT_CHARS = 2000;

/** Segundos maximos de un tiempo de subtitulo (~277 horas). */
export const MAX_SECONDS = 1_000_000;
