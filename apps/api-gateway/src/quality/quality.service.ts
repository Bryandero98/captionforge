import { BadRequestException, Injectable } from "@nestjs/common";

import { JobsService } from "../jobs/jobs.service.js";
import { DEFAULT_PROFILE_ID, PROFILES, QUALITY_PROFILE_IDS, type QualityProfile, getProfile } from "./profiles.js";
import { type QualityReport, checkQuality } from "./verifier.js";

export type QualityReportWithEtag = QualityReport & {
  /** El `etag` de los subtítulos medidos: si cambia, el informe quedó viejo. */
  etag: string;
};

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
