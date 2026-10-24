import { Controller, Get, Param, Query } from "@nestjs/common";

import { JobIdPipe } from "../jobs/job-id.pipe.js";
import { TenantId } from "../tenancy/tenant-auth.guard.js";
import type { QualityProfile } from "./profiles.js";
import { QualityService, type QualityReportWithEtag } from "./quality.service.js";

/** Calidad de subtítulos (ADR 0021). Solo lectura: cualquier rol que pueda ver la transcripción puede pedir el informe. */
@Controller("v1")
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  /** Los perfiles disponibles con sus umbrales (para el selector de la interfaz). */
  @Get("quality/profiles")
  profiles(): { profiles: readonly QualityProfile[] } {
    return { profiles: this.quality.profiles() };
  }

  /** Informe de calidad de una transcripción terminada: `?profile=netflix|bbc|accessible|shorts` (por defecto netflix). */
  @Get("jobs/:id/quality")
  report(
    @TenantId() tenantId: string,
    @Param("id", JobIdPipe) id: string,
    @Query("profile") profile?: string,
  ): Promise<QualityReportWithEtag> {
    return this.quality.report(tenantId, id, profile);
  }
}
