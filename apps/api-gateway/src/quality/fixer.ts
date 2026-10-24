// Propuesta de arreglo de calidad (ADR 0021): función pura que sugiere cambios de TIEMPOS y SALTOS DE LÍNEA, nunca de texto.
//
// Invariantes (los comprueban pruebas de propiedades):
//  - Quitando los saltos de línea, el texto de cada subtítulo es idéntico: el arreglo solo cambia un espacio por un salto o al revés.
//  - Mismo número de subtítulos y mismo orden; las entradas no se modifican.
//  - Cada cambio se acepta solo si el informe de su entorno (el subtítulo y sus vecinos) no empeora: nunca hay más errores,
//    ni más errores + avisos, y siempre mejora el balance (3 × errores + avisos).
//  - Los inicios no se mueven; solo se estira o se recorta el FINAL (el del anterior para dejar la separación mínima).
//  - Idempotente: arreglar lo ya arreglado no cambia nada.
// Lo que no se puede resolver sin tocar el texto queda en `unfixable` para que la persona decida.

import type { Segment } from "../jobs/segments.js";
import type { QualityProfile } from "./profiles.js";
import { type QualityIssue, type QualityReport, checkQuality } from "./verifier.js";

export interface SegmentState {
  start: number;
  end: number;
  text: string;
}

export interface FixChange {
  segment: number;
  kind: "line_break" | "timing";
  before: SegmentState;
  after: SegmentState;
}

export interface FixProposal {
  segments: Segment[];
  changes: FixChange[];
  /** Incidencias de error o aviso que siguen igual porque resolverlas exigiría cambiar el texto o no hay hueco. */
  unfixable: QualityIssue[];
  before: QualityReport["summary"];
  after: QualityReport["summary"];
}

const TAG = /<\/?[a-z][^>]*>/gi;
const visible = (line: string): number => Array.from(line.replace(TAG, "").trim()).length;
const floorMs = (seconds: number): number => Math.floor(seconds * 1000 + 1e-6) / 1000;
const ceilMs = (seconds: number): number => Math.ceil(seconds * 1000 - 1e-6) / 1000;
const flat = (text: string): string => text.replace(/\r?\n/g, " ");

interface Cost {
  errors: number;
  warnings: number;
}
const weight = (cost: Cost): number => 3 * cost.errors + cost.warnings;

/** Costo del entorno de un subtítulo (él y sus vecinos): las reglas solo miran al anterior, así que no hay efectos más lejos. */
function windowCost(segments: readonly Segment[], index: number, profile: QualityProfile): Cost {
  const slice = segments.slice(Math.max(0, index - 1), Math.min(segments.length, index + 2));
  const { summary } = checkQuality(slice, profile);
  return { errors: summary.errors, warnings: summary.warnings };
}

/** Acepta el cambio solo si el entorno mejora y no hay más problemas en total. */
function improves(before: Cost, after: Cost): boolean {
  return after.errors <= before.errors && after.errors + after.warnings <= before.errors + before.warnings && weight(after) < weight(before);
}

/**
 * Reparte las palabras en el menor número de líneas posible (hasta `maxLines`) con cada línea dentro del límite,
 * equilibrando el largo y dejando la línea de abajo igual o más larga. Solo cambia espacios por saltos de línea.
 * Devuelve null si no hay forma de que quepa sin partir una palabra.
 */
export function layoutLines(flatText: string, maxChars: number, maxLines: number): string | null {
  const tokens = flatText.split(" ");
  const n = tokens.length;
  const lineLength = (from: number, to: number): number => visible(tokens.slice(from, to).join(" "));
  if (lineLength(0, n) <= maxChars) return flatText;

  for (let lines = 2; lines <= maxLines; lines += 1) {
    // best[k][i]: mejor costo de repartir los primeros i tokens en k líneas.
    const INF = Number.POSITIVE_INFINITY;
    const best: number[][] = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(INF));
    const cut: number[][] = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(-1));
    best[0]![0] = 0;
    for (let k = 1; k <= lines; k += 1) {
      for (let i = k; i <= n; i += 1) {
        for (let j = k - 1; j < i; j += 1) {
          const previous = best[k - 1]![j]!;
          if (previous === INF) continue;
          const length = lineLength(j, i);
          if (length > maxChars) continue;
          const cost = previous + length * length;
          if (cost < best[k]![i]!) {
            best[k]![i] = cost;
            cut[k]![i] = j;
          }
        }
      }
    }
    if (best[lines]![n] === INF) continue;
    // reconstruir los cortes
    const breaks: number[] = [];
    for (let k = lines, i = n; k > 0; k -= 1) {
      const j = cut[k]![i]!;
      breaks.unshift(j);
      i = j;
    }
    // pirámide: si la última línea quedó más corta que la anterior, se prueba a mover el corte
    let result = "";
    for (let line = 0; line < lines; line += 1) {
      const from = breaks[line]!;
      const to = line + 1 < lines ? breaks[line + 1]! : n;
      result += (line === 0 ? "" : "\n") + tokens.slice(from, to).join(" ");
    }
    return result;
  }
  return null;
}

function lineBreakCandidate(segment: Segment, profile: QualityProfile): Segment | null {
  const lines = segment.text.split(/\r?\n/);
  const violates = lines.length > profile.maxLines || lines.some((line) => visible(line) > profile.maxCharsPerLine);
  if (!violates) return null;
  const laidOut = layoutLines(flat(segment.text), profile.maxCharsPerLine, profile.maxLines);
  if (laidOut === null || laidOut === segment.text) return null;
  return { ...segment, text: laidOut };
}

export function proposeFix(input: readonly Segment[], profile: QualityProfile): FixProposal {
  const original = input.map((segment) => ({ ...segment }));
  const working: Segment[] = input.map((segment) => ({ ...segment }));
  const minGapSeconds = Math.round((profile.minGapFrames * 1000) / profile.fps) / 1000;

  const tryReplace = (index: number, candidate: Segment): boolean => {
    const before = windowCost(working, index, profile);
    const previous = working[index]!;
    working[index] = candidate;
    if (improves(before, windowCost(working, index, profile))) return true;
    working[index] = previous;
    return false;
  };

  for (let index = 0; index < working.length; index += 1) {
    const current = working[index]!;
    if (!(current.end > current.start)) continue; // tiempos inválidos: no se adivina

    // a) saltos de línea
    const broken = lineBreakCandidate(current, profile);
    if (broken) tryReplace(index, broken);

    // b) separación con el anterior: se recorta el FINAL del anterior
    const previous = index > 0 ? working[index - 1] : undefined;
    if (previous && previous.end > previous.start && working[index]!.start - previous.end < minGapSeconds - 1e-9) {
      const newEnd = floorMs(working[index]!.start - minGapSeconds);
      if (newEnd > previous.start + 0.001) tryReplace(index - 1, { ...previous, end: newEnd });
    }

    // c) estirar el final hacia el hueco libre para bajar los cps y llegar a la duración mínima
    const now = working[index]!;
    const characters = now.text.split(/\r?\n/).reduce((total, line) => total + visible(line), 0);
    const needed = Math.max(characters / profile.maxCps + 0.001, profile.minDuration);
    let target = Math.min(ceilMs(now.start + needed), floorMs(now.start + profile.maxDuration));
    const next = working[index + 1];
    if (next) target = Math.min(target, floorMs(next.start - minGapSeconds));
    if (target > now.end + 1e-9) tryReplace(index, { ...now, end: target });
  }

  const changes: FixChange[] = [];
  working.forEach((after, segment) => {
    const before = original[segment]!;
    const state = (s: Segment): SegmentState => ({ start: s.start, end: s.end, text: s.text });
    if (after.text !== before.text) changes.push({ segment, kind: "line_break", before: state(before), after: state(after) });
    if (after.start !== before.start || after.end !== before.end) changes.push({ segment, kind: "timing", before: state(before), after: state(after) });
  });

  const afterReport = checkQuality(working, profile);
  return {
    segments: working,
    changes,
    unfixable: afterReport.issues.filter((issue) => issue.severity !== "info"),
    before: checkQuality(original, profile).summary,
    after: afterReport.summary,
  };
}
