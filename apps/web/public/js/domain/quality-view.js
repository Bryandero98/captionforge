// Vista del editor guiado (ADR 0027) como funciones puras: agrupar incidencias, navegar y calcular las marcas del minimapa.
// No mide nada: las incidencias llegan del servidor (POST /quality/check).

/**
 * @typedef {import("../api/jobs.js").QualityIssue} Issue
 * @typedef {import("../api/jobs.js").QualityCheckFix} Fix
 * @typedef {"error" | "warning" | "info"} Severity
 * @typedef {{ rule: string, severity: Severity, count: number, segments: number[] }} RuleGroup
 * @typedef {{ leftPct: number, widthPct: number, severity: Severity, first: number, count: number, segments: number[] }} MinimapBlock
 */

/** @type {Record<Severity, number>} */
const RANK = { error: 0, warning: 1, info: 2 };
/** Ancho mínimo de una marca del minimapa para poder pulsarla con un dedo. */
const MIN_MARK_PX = 24;

/** @param {Severity} a @param {Severity} b */
const worse = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** @param {Issue[]} issues @returns {Severity | null} */
export function worstSeverity(issues) {
  /** @type {Severity | null} */
  let worst = null;
  for (const { severity } of issues) worst = worst === null ? severity : worse(worst, severity);
  return worst;
}

/**
 * Incidencias agrupadas por regla: peor gravedad, subtítulos afectados (sin repetir, ordenados) y cantidad.
 * Orden: más grave primero y, a igual gravedad, la regla con más subtítulos.
 * @param {Issue[]} issues @returns {RuleGroup[]}
 */
export function groupByRule(issues) {
  /** @type {Map<string, { severity: Severity, segments: Set<number> }>} */
  const groups = new Map();
  for (const { rule, severity, segment } of issues) {
    const group = groups.get(rule);
    if (group === undefined) groups.set(rule, { severity, segments: new Set([segment]) });
    else {
      group.severity = worse(group.severity, severity);
      group.segments.add(segment);
    }
  }
  return [...groups.entries()]
    .map(([rule, { severity, segments }]) => ({ rule, severity, count: segments.size, segments: [...segments].sort((a, b) => a - b) }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count);
}

/** @param {Issue[]} issues @returns {Map<number, Issue[]>} */
export function issuesBySegment(issues) {
  /** @type {Map<number, Issue[]>} */
  const map = new Map();
  for (const issue of issues) map.set(issue.segment, [...(map.get(issue.segment) ?? []), issue]);
  for (const list of map.values()) list.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return map;
}

/** @param {Fix[]} fixes @returns {Map<number, Fix>} */
export function fixesBySegment(fixes) {
  return new Map(fixes.map((fix) => [fix.segment, fix]));
}

/**
 * El siguiente (1) o anterior (-1) subtítulo con incidencias, dando la vuelta. Desde uno sin incidencias va al más cercano.
 * @param {number[]} segments ordenados @param {number | null} current @param {1 | -1} direction @returns {number | null}
 */
export function stepSegment(segments, current, direction) {
  if (segments.length === 0) return null;
  if (current === null) return direction === 1 ? segments[0] : /** @type {number} */ (segments.at(-1));
  if (direction === 1) return segments.find((segment) => segment > current) ?? segments[0];
  return [...segments].reverse().find((segment) => segment < current) ?? /** @type {number} */ (segments.at(-1));
}

/**
 * Marcas del minimapa lógico: la franja se reparte en tramos de al menos 24 px y cada tramo con incidencias es una marca.
 * @param {{ segments: { start: number, end: number }[], issues: Issue[], widthPx: number }} input
 * @returns {MinimapBlock[]}
 */
export function minimapBlocks({ segments, issues, widthPx }) {
  const total = segments.reduce((max, segment) => Math.max(max, segment.end), 0);
  const buckets = Math.max(1, Math.floor((Number.isFinite(widthPx) ? widthPx : 0) / MIN_MARK_PX));
  /** @type {Map<number, { severity: Severity, segments: Set<number> }>} */
  const found = new Map();
  for (const { segment, severity } of issues) {
    const position = segments[segment];
    if (position === undefined) continue;
    const middle = (position.start + position.end) / 2;
    const bucket = total > 0 ? Math.min(buckets - 1, Math.max(0, Math.floor((middle / total) * buckets))) : 0;
    const entry = found.get(bucket);
    if (entry === undefined) found.set(bucket, { severity, segments: new Set([segment]) });
    else {
      entry.severity = worse(entry.severity, severity);
      entry.segments.add(segment);
    }
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, { severity, segments: affected }]) => {
      const list = [...affected].sort((a, b) => a - b);
      return { leftPct: (bucket * 100) / buckets, widthPct: 100 / buckets, severity, first: /** @type {number} */ (list[0]), count: list.length, segments: list };
    });
}
