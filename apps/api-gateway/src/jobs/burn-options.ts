// Opciones del quemado que el API valida y publica. Las plantillas y los lienzos son los enums de `burn-job.v1.json`
// (una prueba compara ambos); viven aquí, y no dentro del servicio, para que `GET /v1/capabilities` las anuncie sin importarlo.
export const BURN_STYLES = ["modern", "tiktok", "youtube", "minimal"] as const;
export const BURN_TEMPLATES = ["bold-pop", "rounded-sweep", "clean-color"] as const;
export const BURN_CANVASES = ["source", "vertical"] as const;
export const BURN_OPTION_KEYS: readonly string[] = ["style", "karaoke", "template", "canvas"];
