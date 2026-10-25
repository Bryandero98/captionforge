import { BadRequestException, Injectable } from "@nestjs/common";

import { JobsService } from "../jobs/jobs.service.js";
import { MAX_SEGMENTS, type Segment } from "../jobs/segments.js";
import { type FixChange, proposeFix } from "./fixer.js";
import { DEFAULT_PROFILE_ID, PROFILES, QUALITY_PROFILE_IDS, type QualityProfile, getProfile } from "./profiles.js";
import { type QualityIssue, type QualityReport, type QualityRule, checkQuality } from "./verifier.js";

export type QualityReportWithEtag = QualityReport & {
  /** El `etag` de los subtítulos medidos: si cambia, el informe quedó viejo. */
  etag: string;
};

export interface QualityFix {
  profile: string;
  /** El `etag` de los subtítulos sobre los que se calculó: se pasa tal cual a `PUT /v1/jobs/:id/segments`. */
  etag: string;
  /** Ediciones listas para `PUT /v1/jobs/:id/segments` (solo texto con otros saltos de línea y tiempos). */
  edits: { index: number; text?: string; start?: number; end?: number }[];
  changes: FixChange[];
  unfixable: QualityIssue[];
  before: QualityReport["summary"];
  after: QualityReport["summary"];
}

/** Una corrección de un subtítulo, lista para escribirse en el estado local del editor (no guarda nada). */
export interface QualityCheckFix {
  segment: number;
  /** Reglas de este subtítulo que la corrección resuelve. */
  rules: QualityRule[];
  kinds: FixChange["kind"][];
  edit: { start?: number; end?: number; text?: string };
}

export type QualityCheck = QualityReport & { fixes: QualityCheckFix[] };

const MAX_TEXT = 2_000;
const MAX_SECONDS = 1_000_000;

/** Mide los subtítulos de una transcripción terminada. Solo lee: no guarda nada ni toca el texto. */
@Injectable()
export class QualityService {
  constructor(private readonly jobs: JobsService) {}

  async report(tenantId: string, jobId: string, profileId: string | undefined): Promise<QualityReportWithEtag> {
    const profile = this.resolveProfile(profileId);
    // Los subtítulos solo se leen con un perfil válido, y getSegments aplica el aislamiento por tenant (404 si no es suyo).
    const { segments, etag } = await this.jobs.getSegments(tenantId, jobId);
    return { ...checkQuality(segments, profile), etag };
  }

  /** Propone el arreglo (tiempos y saltos de línea). No guarda nada: la persona lo aplica con el flujo de edición. */
  async fix(tenantId: string, jobId: string, profileId: string | undefined): Promise<QualityFix> {
    const profile = this.resolveProfile(profileId);
    const { segments, etag } = await this.jobs.getSegments(tenantId, jobId);
    const proposal = proposeFix(segments, profile);
    const edits = proposal.segments.flatMap((fixed, index) => {
      const original = segments[index]!;
      const textChanged = fixed.text !== original.text;
      const timeChanged = fixed.start !== original.start || fixed.end !== original.end;
      if (!textChanged && !timeChanged) return [];
      return [{ index, ...(textChanged ? { text: fixed.text } : {}), ...(timeChanged ? { start: fixed.start, end: fixed.end } : {}) }];
    });
    return { profile: profile.id, etag, edits, changes: proposal.changes, unfixable: proposal.unfixable, before: proposal.before, after: proposal.after };
  }

  /**
   * Mide los subtítulos que manda el cliente (sin guardar, sin leer los guardados) y propone un arreglo por subtítulo.
   * Sirve al editor guiado, que re-evalúa tras cada edición. Solo exige que el trabajo sea del tenant y esté terminado.
   */
  async check(tenantId: string, jobId: string, body: unknown): Promise<QualityCheck> {
    const record = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (record === null) throw new BadRequestException("El cuerpo debe ser un objeto con profile y segments.");
    if (typeof record.profile !== "string") throw new BadRequestException("Falta el perfil de calidad.");
    const profile = this.resolveProfile(record.profile);
    const segments = parseCheckSegments(record.segments);
    await this.jobs.requireTranscription(tenantId, jobId);

    const report = checkQuality(segments, profile);
    const proposal = proposeFix(segments, profile);
    const after = checkQuality(proposal.segments, profile);
    const fixes: QualityCheckFix[] = [];
    proposal.segments.forEach((fixed, segment) => {
      const original = segments[segment]!;
      const edit: QualityCheckFix["edit"] = {};
      if (fixed.text !== original.text) edit.text = fixed.text;
      if (fixed.start !== original.start) edit.start = fixed.start;
      if (fixed.end !== original.end) edit.end = fixed.end;
      if (Object.keys(edit).length === 0) return;
      const remaining = new Set(after.issues.filter((issue) => issue.segment === segment).map((issue) => issue.rule));
      const rules = [...new Set(report.issues.filter((issue) => issue.segment === segment).map((issue) => issue.rule))].filter((rule) => !remaining.has(rule));
      const kinds = [...new Set(proposal.changes.filter((change) => change.segment === segment).map((change) => change.kind))];
      fixes.push({ segment, rules, kinds, edit });
    });
    return { ...report, fixes };
  }

  profiles(): readonly QualityProfile[] {
    return PROFILES;
  }

  private resolveProfile(profileId: string | undefined): QualityProfile {
    if (profileId === undefined) return getProfile(DEFAULT_PROFILE_ID);
    if (!QUALITY_PROFILE_IDS.includes(profileId)) {
      throw new BadRequestException(`Perfil de calidad desconocido. Disponibles: ${QUALITY_PROFILE_IDS.join(", ")}.`);
    }
    return getProfile(profileId);
  }
}

/** Los subtítulos del editor: solo tiempos y texto. Los tiempos incoherentes se aceptan (el verificador los marca). */
function parseCheckSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) throw new BadRequestException("segments debe ser una lista.");
  if (raw.length > MAX_SEGMENTS) throw new BadRequestException(`Hay demasiados subtítulos (máximo ${MAX_SEGMENTS}).`);
  return raw.map((item: unknown, index) => {
    const entry = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (entry === null) throw new BadRequestException(`El subtítulo ${index} no es un objeto.`);
    const { start, end, text } = entry;
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;
    if (!valid(start) || !valid(end) || typeof text !== "string") throw new BadRequestException(`El subtítulo ${index} necesita start y end válidos y text.`);
    if (text.length > MAX_TEXT) throw new BadRequestException(`El texto del subtítulo ${index} es demasiado largo (máximo ${MAX_TEXT}).`);
    return { start, end, text, words: null };
  });
}
