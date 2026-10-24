// Verificador de calidad de subtítulos (ADR 0021): función pura, sin base de datos, sin red, sin reloj.
// Entrada: los segmentos y un perfil. Salida: qué incumple cada subtítulo y por cuánto.
// No modifica nada ni propone textos: el texto es del usuario.

import type { Segment } from "../jobs/segments.js";
import type { QualityProfile } from "./profiles.js";

export type Severity = "error" | "warning" | "info";
export type QualityRule = "cps" | "cpl" | "lines" | "duration_min" | "duration_max" | "gap_min" | "overlap" | "invalid_timing" | "balance";

export interface QualityIssue {
  /** Índice del subtítulo en la lista (empieza en 0). */
  segment: number;
  rule: QualityRule;
  severity: Severity;
  /** Lo medido (cps, caracteres, segundos o milisegundos según la regla). */
  measured: number;
  /** El límite del perfil que se incumple. */
  limit: number;
  /** Para `cpl`: la línea (empieza en 1) que se pasa. */
  line?: number;
}

export interface QualityReport {
  profile: string;
  summary: {
    segments: number;
    errors: number;
    warnings: number;
    infos: number;
    /** Porcentaje de subtítulos sin errores ni avisos (las informaciones no cuentan). */
    score: number;
  };
  issues: QualityIssue[];
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };
/** Una línea más corta que esta fracción de la otra (con la larga de al menos 20 caracteres) se avisa como desequilibrada. */
const BALANCE_RATIO = 0.5;
const BALANCE_MIN_LONGEST = 20;
const TAG = /<\/?[a-z][^>]*>/gi;

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Longitud visible: sin etiquetas de formato ni espacios en los extremos, contada por puntos de código (un emoji es un carácter). */
const visibleLength = (line: string): number => Array.from(line.replace(TAG, "").trim()).length;

export function checkQuality(segments: readonly Segment[], profile: QualityProfile): QualityReport {
  const issues: QualityIssue[] = [];
  const dirty = new Set<number>();
  const add = (issue: QualityIssue): void => {
    issues.push(issue);
    if (issue.severity !== "info") dirty.add(issue.segment);
  };
  const minGapMs = Math.round((profile.minGapFrames * 1000) / profile.fps);

  segments.forEach((segment, index) => {
    const duration = segment.end - segment.start;
    const lines = segment.text.split(/\r?\n/);

    if (!(duration > 0)) {
      add({ segment: index, rule: "invalid_timing", severity: "error", measured: round(duration, 3), limit: 0 });
    } else {
      const characters = lines.reduce((total, line) => total + visibleLength(line), 0);
      const cps = characters / duration;
      if (cps > profile.maxCps) {
        add({
          segment: index,
          rule: "cps",
          severity: cps > profile.maxCps + profile.cpsErrorMargin ? "error" : "warning",
          measured: round(cps, 1),
          limit: profile.maxCps,
        });
      }
      if (duration < profile.minDuration) {
        add({ segment: index, rule: "duration_min", severity: "warning", measured: round(duration, 3), limit: round(profile.minDuration, 3) });
      }
      if (duration > profile.maxDuration) {
        add({ segment: index, rule: "duration_max", severity: "warning", measured: round(duration, 3), limit: profile.maxDuration });
      }
    }

    if (lines.length > profile.maxLines) {
      add({ segment: index, rule: "lines", severity: "error", measured: lines.length, limit: profile.maxLines });
    }
    const lengths = lines.map(visibleLength);
    lengths.forEach((length, lineIndex) => {
      if (length > profile.maxCharsPerLine) {
        add({ segment: index, rule: "cpl", severity: "error", measured: length, limit: profile.maxCharsPerLine, line: lineIndex + 1 });
      }
    });
    if (lengths.length === 2) {
      const longest = Math.max(...lengths);
      const shortest = Math.min(...lengths);
      if (longest >= BALANCE_MIN_LONGEST && shortest / longest < BALANCE_RATIO) {
        add({ segment: index, rule: "balance", severity: "info", measured: round(shortest / longest, 2), limit: BALANCE_RATIO });
      }
    }

    const previous = index > 0 ? segments[index - 1] : undefined;
    if (previous) {
      const gap = segment.start - previous.end;
      if (gap < 0) {
        add({ segment: index, rule: "overlap", severity: "error", measured: round(-gap, 3), limit: 0 });
      } else if (Math.round(gap * 1000) < minGapMs) {
        add({ segment: index, rule: "gap_min", severity: "warning", measured: Math.round(gap * 1000), limit: minGapMs });
      }
    }
  });

  issues.sort((a, b) => a.segment - b.segment || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const count = (severity: Severity): number => issues.filter((issue) => issue.severity === severity).length;
  return {
    profile: profile.id,
    summary: {
      segments: segments.length,
      errors: count("error"),
      warnings: count("warning"),
      infos: count("info"),
      score: segments.length === 0 ? 100 : Math.round((100 * (segments.length - dirty.size)) / segments.length),
    },
    issues,
  };
}
