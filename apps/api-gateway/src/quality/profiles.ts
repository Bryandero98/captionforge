// Perfiles de calidad de subtítulos (ADR 0021). Son datos: el verificador no tiene ningún número escrito dentro.
//
// Cada perfil cita su fuente en `reference` y declara en `verification` cuánto de él se leyó en la fuente oficial y cuánto es criterio propio.
// No es una certificación: es una medida contra las cifras publicadas por cada guía.

export interface QualityProfile {
  /** Identificador estable que se usa en la API (`?profile=`). */
  id: string;
  /** Nombre para mostrar. */
  label: string;
  /** De dónde salen los umbrales. */
  reference: string;
  /** Qué tan contrastados están con la fuente: `verified` (leídos en la fuente), `partial` (una parte es criterio propio), `unverified` (sin acceso a la fuente primaria) o `own-criteria`. */
  verification: "verified" | "partial" | "unverified" | "own-criteria";
  /** Fotogramas por segundo con los que se traduce `minGapFrames` a milisegundos. */
  fps: number;
  maxLines: number;
  maxCharsPerLine: number;
  /** Caracteres por segundo permitidos; por encima es un aviso. */
  maxCps: number;
  /** Cuántos cps por encima de `maxCps` pasan de aviso a error. */
  cpsErrorMargin: number;
  /** Segundos. */
  minDuration: number;
  maxDuration: number;
  /** Separación mínima entre un subtítulo y el siguiente, en fotogramas. */
  minGapFrames: number;
}

export const PROFILES: readonly QualityProfile[] = [
  {
    id: "netflix",
    label: "Netflix (inglés)",
    verification: "verified",
    reference:
      "Netflix Timed Text Style Guide (partnerhelp.netflixstudios.com, artículos 217350977, 215758617 y 360051554394): 42 caracteres por línea, 2 líneas, hasta 20 cps en adultos (inglés), 5/6 s a 7 s de duración y 2 fotogramas como mínimo entre subtítulos.",
    fps: 24,
    maxLines: 2,
    maxCharsPerLine: 42,
    maxCps: 20,
    cpsErrorMargin: 3,
    minDuration: 5 / 6,
    maxDuration: 7,
    minGapFrames: 2,
  },
  {
    id: "netflix-es",
    label: "Netflix (español)",
    verification: "verified",
    reference:
      "Netflix Spanish Timed Text Style Guide (artículo 216014517, §15): hasta 17 cps en adultos; el resto de los límites (42 caracteres, 2 líneas, 5/6 s a 7 s, 2 fotogramas) son los generales de Netflix.",
    fps: 24,
    maxLines: 2,
    maxCharsPerLine: 42,
    maxCps: 17,
    cpsErrorMargin: 3,
    minDuration: 5 / 6,
    maxDuration: 7,
    minGapFrames: 2,
  },
  {
    id: "bbc",
    label: "BBC",
    verification: "unverified",
    reference:
      "BBC Subtitle Guidelines (bbc.co.uk/accessibility/forproducts/guides/subtitles). NO verificado contra la fuente primaria (no fue accesible): 37 caracteres por línea y 160-180 palabras por minuto salen de copias secundarias; 18 cps es 180 wpm con 6 caracteres por palabra. Revisar con la guía abierta.",
    fps: 25,
    maxLines: 2,
    maxCharsPerLine: 37,
    maxCps: 18,
    cpsErrorMargin: 3,
    minDuration: 1,
    maxDuration: 7,
    minGapFrames: 2,
  },
  {
    id: "accessible",
    label: "Accesible (sordos y baja visión)",
    verification: "partial",
    reference:
      "DCMP Captioning Key (dcmp.org/captioningkey): preferible no más de 2 líneas, velocidad de 130/140/160 wpm según el nivel (aquí 140 wpm ≈ 14 cps con 6 caracteres por palabra), mínimo 40 fotogramas (≈1,33 s a 30 fps) y máximo 6 s. La guía no fija caracteres por línea ni separación: 32 y 3 fotogramas son criterio propio de CaptionForge.",
    fps: 30,
    maxLines: 2,
    maxCharsPerLine: 32,
    maxCps: 14,
    cpsErrorMargin: 3,
    minDuration: 40 / 30,
    maxDuration: 6,
    minGapFrames: 3,
  },
  {
    id: "shorts",
    label: "Cortos verticales (Shorts, TikTok, Reels)",
    verification: "own-criteria",
    reference:
      "Criterio propio de CaptionForge: no se encontraron cifras oficiales de las plataformas. Líneas de hasta 32 caracteres para dejar margen en 9:16, 2 líneas, 17 cps (techo del español adulto de Netflix), 1 s a 6 s y 2 fotogramas a 30 fps.",
    fps: 30,
    maxLines: 2,
    maxCharsPerLine: 32,
    maxCps: 17,
    cpsErrorMargin: 4,
    minDuration: 1,
    maxDuration: 6,
    minGapFrames: 2,
  },
];

export const QUALITY_PROFILE_IDS: readonly string[] = PROFILES.map((profile) => profile.id);
export const DEFAULT_PROFILE_ID = "netflix";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const positiveInteger = (value: unknown): value is number => positive(value) && Number.isInteger(value);

/** Rechaza un perfil con números imposibles: un perfil roto no debe llegar a medir nada. */
export function validateProfile(profile: QualityProfile): QualityProfile {
  const problems: string[] = [];
  if (!ID_PATTERN.test(profile.id)) problems.push("id");
  if (typeof profile.label !== "string" || profile.label.trim() === "") problems.push("label");
  if (typeof profile.reference !== "string" || profile.reference.trim() === "") problems.push("reference");
  if (!["verified", "partial", "unverified", "own-criteria"].includes(profile.verification)) problems.push("verification");
  if (!positive(profile.fps) || profile.fps > 120) problems.push("fps");
  if (!positiveInteger(profile.maxLines)) problems.push("maxLines");
  if (!positiveInteger(profile.maxCharsPerLine)) problems.push("maxCharsPerLine");
  if (!positive(profile.maxCps)) problems.push("maxCps");
  if (typeof profile.cpsErrorMargin !== "number" || !Number.isFinite(profile.cpsErrorMargin) || profile.cpsErrorMargin < 0) problems.push("cpsErrorMargin");
  if (!positive(profile.minDuration)) problems.push("minDuration");
  if (!positive(profile.maxDuration) || profile.maxDuration <= profile.minDuration) problems.push("maxDuration");
  if (typeof profile.minGapFrames !== "number" || !Number.isInteger(profile.minGapFrames) || profile.minGapFrames < 0) problems.push("minGapFrames");
  if (problems.length > 0) throw new Error(`Perfil de calidad inválido (${profile.id}): ${problems.join(", ")}.`);
  return profile;
}

for (const profile of PROFILES) validateProfile(profile);

export function getProfile(id: string): QualityProfile {
  const found = PROFILES.find((profile) => profile.id === id);
  if (!found) throw new Error(`No existe el perfil de calidad «${id}». Disponibles: ${QUALITY_PROFILE_IDS.join(", ")}.`);
  return found;
}
