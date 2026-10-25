import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import { JobIdPipe } from "../jobs/job-id.pipe.js";
import { TenantId } from "../tenancy/tenant-auth.guard.js";
import type { QualityProfile } from "./profiles.js";
import { QualityService, type QualityCheck, type QualityFix, type QualityReportWithEtag } from "./quality.service.js";

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

  /**
   * Propone el arreglo de tiempos y saltos de línea: { "profile": "netflix" }. Solo calcula: devuelve `edits` para aplicar con
   * `PUT /v1/jobs/:id/segments` (con el mismo `etag`) y lo que no se puede resolver sin cambiar el texto.
   */
  @Post("jobs/:id/quality/fix")
  @HttpCode(200)
  fix(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<QualityFix> {
    const profile = typeof body === "object" && body !== null && "profile" in body ? (body as { profile: unknown }).profile : undefined;
    return this.quality.fix(tenantId, id, typeof profile === "string" ? profile : undefined);
  }

  /**
   * Mide subtítulos que aún no se guardaron: { "profile": "netflix", "segments": [ { "start": 0, "end": 2, "text": "..." } ] }.
   * Sin estado: no lee ni escribe subtítulos. Devuelve el informe y, por subtítulo, la edición que lo arregla (editor guiado).
   */
  @Post("jobs/:id/quality/check")
  @HttpCode(200)
  check(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<QualityCheck> {
    return this.quality.check(tenantId, id, body);
  }
}
