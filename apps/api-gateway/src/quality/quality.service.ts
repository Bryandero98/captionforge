import { BadRequestException, Injectable } from "@nestjs/common";

import { JobsService } from "../jobs/jobs.service.js";
import { type FixChange, proposeFix } from "./fixer.js";
import { DEFAULT_PROFILE_ID, PROFILES, QUALITY_PROFILE_IDS, type QualityProfile, getProfile } from "./profiles.js";
import { type QualityIssue, type QualityReport, checkQuality } from "./verifier.js";

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
