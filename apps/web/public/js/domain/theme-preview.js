// Vista previa aproximada de un tema (v1.3.0): del catálogo a variables CSS y al estado de cada palabra. Funciones puras, sin DOM.
// Es una imitación: libass y el navegador difieren unos píxeles (suavizado, contorno, métricas). La interfaz lo dice («Vista aproximada»).
//
// Las variables llevan proporciones de la altura del marco (`--cf-size: 0.052` = 5,2 % de la altura); el CSS las convierte con `cqh`.

/** Familias de la vista previa: las fuentes del motor van empaquetadas (public/fonts); Arial es la del estilo clásico. */
export const FONT_STACKS = Object.freeze({
  arial: 'Arial, "Liberation Sans", Helvetica, sans-serif',
  montserrat: '"CF Montserrat", Montserrat, "Arial Black", Arial, sans-serif',
  nunito: '"CF Nunito", Nunito, "Trebuchet MS", Arial, sans-serif',
});

/** Etiquetas de formato que Whisper o la edición pueden dejar en el texto: no se pintan. */
const TAG = /<\/?[a-z][^>]*>/gi;

/**
 * @param {import("./themes.js").ThemeData} theme
 * @param {{ karaoke?: boolean }} [options]
 * @returns {{ mode: "static" | "pop" | "sweep" | "color", vars: Record<string, string> }}
 */
export function previewStyle(theme, { karaoke = false } = {}) {
  const p = theme.preview;
  // Un estilo clásico con karaoke se dibuja como barrido con los colores del karaoke de ASS.
  const sweep = karaoke === true && p.karaoke !== null;
  const base = sweep ? /** @type {NonNullable<typeof p.karaoke>} */ (p.karaoke).base : p.base;
  const lit = sweep ? /** @type {NonNullable<typeof p.karaoke>} */ (p.karaoke).lit : p.lit;
  return {
    mode: sweep ? "sweep" : p.mode,
    vars: {
      "--cf-font": FONT_STACKS[p.font] ?? FONT_STACKS.arial,
      "--cf-weight": p.bold ? "800" : "400",
      "--cf-transform": p.upper ? "uppercase" : "none",
      "--cf-size": String(p.sizeRatio),
      "--cf-margin": String(p.marginRatio),
      "--cf-outline": String(p.outlineRatio),
      "--cf-shadow": String(p.shadowRatio),
      "--cf-base": base,
      "--cf-lit": lit,
      "--cf-outline-colour": p.outline,
      "--cf-box": p.box ?? "transparent",
      "--cf-pop": String(p.popScale / 100),
    },
  };
}

/**
 * Las palabras que se pintan: las primeras que cabrían en pantalla en ese tema, del texto de la persona (sin etiquetas) o, si no hay,
 * de la muestra.
 * @param {import("./themes.js").ThemeData} theme @param {unknown} text @param {readonly string[]} [sample]
 * @returns {string[]}
 */
export function previewWords(theme, text, sample = []) {
  const clean = typeof text === "string" ? text.replace(TAG, " ").split(/\s+/).filter(Boolean) : [];
  const words = clean.length > 0 ? clean : [...sample];
  return words.slice(0, theme.preview.maxWords);
}

/**
 * Estado de cada palabra en un instante del ciclo.
 *   idle    texto aún sin decir (color base)
 *   active  la palabra que se dice ahora
 *   sung    ya dicha, solo en barrido (color encendido)
 * @param {"static" | "pop" | "sweep" | "color"} mode @param {number} count @param {number} tick
 * @param {{ reduced?: boolean }} [options] `reduced`: movimiento reducido, una foto fija
 * @returns {("idle" | "active" | "sung")[]}
 */
export function wordStates(mode, count, tick, { reduced = false } = {}) {
  if (!Number.isInteger(count) || count <= 0) return [];
  if (mode === "static") return Array.from({ length: count }, () => "idle");
  if (reduced) return Array.from({ length: count }, (_, index) => (mode === "sweep" ? "sung" : index === 0 ? "active" : "idle"));
  const at = Number.isFinite(tick) && tick > 0 ? Math.floor(tick) % count : 0;
  return Array.from({ length: count }, (_, index) => (index === at ? "active" : mode === "sweep" && index < at ? "sung" : "idle"));
}
