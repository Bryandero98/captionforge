// Temas visuales (v1.3.0, iniciativa 3). Un tema es un nombre amable que se traduce a las opciones explícitas de siempre de
// POST /v1/jobs/:id/burn (estilo clásico, o lienzo vertical + plantilla): el contrato de la API no cambia. El catálogo sale de
// packages/contracts/themes.v1.json (themes-data.js, generado) y describe además cómo imitar el tema en el navegador.

import { DEFAULT_VERTICAL_MAX_SECONDS } from "./burn-options.js";
import { THEMES_DATA, THEMES_DEFAULT_ID } from "./themes-data.js";

/**
 * @typedef {{ base: string, lit: string }} KaraokeColours
 * @typedef {{
 *   font: "arial" | "montserrat" | "nunito", bold: boolean, mode: "static" | "pop" | "sweep" | "color", maxWords: number,
 *   sizeRatio: number, marginRatio: number, outlineRatio: number, shadowRatio: number, upper: boolean, popScale: number,
 *   base: string, lit: string, outline: string, box: string | null, karaoke: KaraokeColours | null,
 * }} ThemePreview
 * @typedef {{
 *   id: string, group: "source" | "vertical",
 *   burn: { style?: string, template?: string, canvas?: "vertical" },
 *   preview: ThemePreview,
 * }} ThemeData
 */

const freezeDeep = (/** @type {any} */ value) => {
  if (value !== null && typeof value === "object") for (const inner of Object.values(value)) freezeDeep(inner);
  return Object.freeze(value);
};

/** @type {readonly ThemeData[]} */
export const THEMES = freezeDeep(THEMES_DATA.map((theme) => structuredClone(theme)));
export const DEFAULT_THEME_ID = THEMES_DEFAULT_ID;
/** Orden de los grupos en la galería. */
export const THEME_GROUPS = /** @type {const} */ (["source", "vertical"]);

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));
const DEFAULT_THEME = /** @type {ThemeData} */ (BY_ID.get(DEFAULT_THEME_ID));

/** Un id desconocido (o roto) es el tema por defecto: nunca lanza. @param {unknown} id @returns {ThemeData} */
export const themeById = (id) => (typeof id === "string" ? (BY_ID.get(id) ?? DEFAULT_THEME) : DEFAULT_THEME);

/** @returns {{ group: "source" | "vertical", themes: ThemeData[] }[]} */
export const groupedThemes = () => THEME_GROUPS.map((group) => ({ group, themes: THEMES.filter((theme) => theme.group === group) }));

/**
 * Las opciones de POST /v1/jobs/:id/burn de un tema, exactamente las de siempre: un clásico manda estilo y karaoke; un vertical, lienzo y
 * plantilla (sin karaoke: la plantilla ya resalta palabra por palabra).
 * @param {ThemeData} theme @param {{ karaoke?: boolean }} [options]
 * @returns {{ style: string, karaoke: boolean } | { canvas: "vertical", template: string }}
 */
export function burnRequestOf(theme, { karaoke = false } = {}) {
  if (theme.group === "vertical") return { canvas: "vertical", template: /** @type {string} */ (theme.burn.template) };
  return { style: /** @type {string} */ (theme.burn.style), karaoke: karaoke === true };
}

/** Lo que «Sube y olvídate» encadena para un tema (la forma de la fase 1). @param {ThemeData} theme @returns {{ burn: { canvas: "source" | "vertical", template?: string, style?: string } }} */
export function followUpOf(theme) {
  if (theme.group === "vertical") return { burn: { canvas: "vertical", template: /** @type {string} */ (theme.burn.template) } };
  return { burn: { canvas: "source", style: /** @type {string} */ (theme.burn.style) } };
}

/** Del par «formato + plantilla/estilo» de las preferencias de la v1.3.0 (fase 1) al tema equivalente. @param {{ format?: unknown, template?: unknown, style?: unknown } | null | undefined} legacy */
export function themeForLegacy(legacy) {
  if (legacy?.format === "vertical") {
    return THEMES.find((theme) => theme.group === "vertical" && theme.burn.template === legacy.template) ?? /** @type {ThemeData} */ (BY_ID.get("shorts-dynamic"));
  }
  return THEMES.find((theme) => theme.group === "source" && theme.burn.style === legacy?.style) ?? DEFAULT_THEME;
}

/** @param {unknown} value @returns {value is number} */
const known = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * ¿Se puede usar este tema ahora? `null` si sí; si no, el motivo (un código cerrado que la interfaz traduce).
 * Sin duración conocida no se promete lo contrario: el servidor decide (413 con mensaje claro).
 * @param {ThemeData} theme
 * @param {{ durationSeconds?: unknown, caps?: { limits?: { verticalMaxSeconds?: number }, burn?: { templates?: readonly string[] } } | null }} context
 * @returns {{ code: "vertical_too_long", maxMinutes: number } | { code: "template_unavailable" } | null}
 */
export function unavailableReason(theme, { durationSeconds, caps }) {
  if (theme.group !== "vertical") return null;
  const offered = caps?.burn?.templates;
  if (Array.isArray(offered) && !offered.includes(/** @type {string} */ (theme.burn.template))) return { code: "template_unavailable" };
  const max = known(caps?.limits?.verticalMaxSeconds) ? caps.limits.verticalMaxSeconds : DEFAULT_VERTICAL_MAX_SECONDS;
  if (known(durationSeconds) && durationSeconds > max) return { code: "vertical_too_long", maxMinutes: Math.round(max / 60) };
  return null;
}
