// Frases del editor guiado (ADR 0027). El traductor no tiene plurales: cada regla tiene una clave `.one` y otra `.other`.

import { groupByRule } from "./quality-view.js";

/** Reglas que el servidor puede reportar (cada una tiene su frase en singular y plural). */
export const RULE_ORDER = /** @type {const} */ (["cps", "cpl", "lines", "duration_min", "duration_max", "gap_min", "overlap", "invalid_timing", "balance"]);

/**
 * Una ficha por regla para la cabecera («3 demasiado rápidos», «1 solapamiento»).
 * @param {import("../api/jobs.js").QualityIssue[]} issues
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
export function headlineChips(issues, t) {
  return groupByRule(issues).map(({ rule, severity, count, segments }) => {
    const known = /** @type {readonly string[]} */ (RULE_ORDER).includes(rule) ? rule : "other";
    return { rule, severity, count, segments, text: t(`guided.rule.${known}.${count === 1 ? "one" : "other"}`, { count }) };
  });
}

/**
 * Insignia de calidad del resultado («Calidad 92 % · 3 avisos»). Cuenta errores y avisos; las sugerencias no.
 * @param {import("../api/jobs.js").QualitySummary} summary
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
export function badgeText(summary, t) {
  const count = summary.errors + summary.warnings;
  return count === 0 ? t("guided.badge.clean", { score: summary.score }) : t("guided.badge", { score: summary.score, count });
}

/**
 * La frase de una incidencia («lectura demasiado rápida, 21,5 caracteres por segundo (límite 20)»).
 * @param {import("../api/jobs.js").QualityIssue} issue
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {(value: number, digits?: number) => string} formatNumber
 */
export function describeIssue(issue, t, formatNumber) {
  return t(`quality.rule.${issue.rule}`, { measured: formatNumber(issue.measured, 2), limit: formatNumber(issue.limit, 2), line: issue.line ?? 1, percent: Math.round(issue.measured * 100) });
}

/**
 * Qué hace un arreglo, en frases cortas para el botón («Partir en líneas», «Final a 3,25 s»).
 * @param {import("../api/jobs.js").QualityCheckFix} fix
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {(value: number, digits?: number) => string} formatNumber
 * @returns {string[]}
 */
export function describeFix(fix, t, formatNumber) {
  const parts = [];
  if (fix.edit.text !== undefined) parts.push(t("guided.fix.line_break"));
  if (fix.edit.start !== undefined) parts.push(t("guided.fix.start", { time: formatNumber(fix.edit.start, 2) }));
  if (fix.edit.end !== undefined) parts.push(t("guided.fix.end", { time: formatNumber(fix.edit.end, 2) }));
  return parts;
}
