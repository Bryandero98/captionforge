// Perfiles de calidad de subtítulos (ADR 0021). Son datos: el verificador no tiene ningún número escrito dentro.
//
// Los valores salen de guías públicas y están pensados como punto de partida razonable, no como certificación:
// cada perfil cita su fuente en `reference` y los umbrales se contrastan con ella en la tarea T1 antes de publicarse.

export interface QualityProfile {
  /** Identificador estable que se usa en la API (`?profile=`). */
  id: string;
  /** Nombre para mostrar. */
  label: string;
  /** De dónde salen los umbrales. */
  reference: string;
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
    label: "Netflix",
    reference: "Netflix Timed Text Style Guide (reglas generales): 42 caracteres por línea, 2 líneas, 20 cps adultos, 5/6 s a 7 s, 2 fotogramas de hueco.",
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
    id: "bbc",
    label: "BBC",
    reference: "BBC Subtitle Guidelines: 37 caracteres por línea, 2 líneas, 160-180 palabras por minuto (aprox. 16-18 cps), 7 s como máximo.",
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
    label: "Accesible",
    reference: "DCMP Captioning Key y WCAG 2.2 (1.2.2): lectura cómoda para personas sordas o con baja visión, unos 140 palabras por minuto (aprox. 14 cps).",
    fps: 25,
    maxLines: 2,
    maxCharsPerLine: 32,
    maxCps: 14,
    cpsErrorMargin: 3,
    minDuration: 1.5,
    maxDuration: 6,
    minGapFrames: 3,
  },
  {
    id: "shorts",
    label: "Cortos verticales (Shorts, TikTok, Reels)",
    reference: "Práctica de plataformas verticales 9:16: líneas cortas dentro de la zona segura, ritmo rápido y cambios de pantalla frecuentes (criterio de CaptionForge).",
    fps: 30,
    maxLines: 2,
    maxCharsPerLine: 20,
    maxCps: 22,
    cpsErrorMargin: 4,
    minDuration: 0.5,
    maxDuration: 4,
    minGapFrames: 1,
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
