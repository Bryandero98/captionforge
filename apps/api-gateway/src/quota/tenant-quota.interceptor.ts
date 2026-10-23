import { CallHandler, type ExecutionContext, HttpException, HttpStatus, Injectable, type NestInterceptor, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Observable } from "rxjs";

import { MetricsService } from "../observability/metrics.service.js";
import { TenantQuotaService, type QuotaDenial } from "./tenant-quota.service.js";

export type QuotaKind = "upload" | "queue";
const QUOTA = "captionforge:quota";

/** Marca una ruta con la cuota que debe cumplir el tenant antes de que se ejecute. */
export const Quota = (kind: QuotaKind) => SetMetadata(QUOTA, kind);

const MESSAGES: Record<QuotaDenial["reason"], string> = {
  uploads: "Alcanzaste el máximo de subidas por hora de tu cuenta.",
  queue: "Tienes demasiados trabajos en curso; espera a que termine alguno.",
};

/**
 * Aplica la cuota por tenant ANTES del controlador (el cuerpo aún no se leyó: main.ts lo descarta con límite). Va después
 * de TenantAuthGuard, así que `request.tenantId` ya existe; sin él no hay nada que medir.
 */
@Injectable()
export class TenantQuotaInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly quota: TenantQuotaService,
    private readonly metrics: MetricsService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const kind = this.reflector.get<QuotaKind | undefined>(QUOTA, context.getHandler());
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (kind !== undefined && request.tenantId !== undefined) {
      const denial = kind === "upload" ? await this.quota.checkUpload(request.tenantId) : await this.quota.checkQueue(request.tenantId);
      if (denial !== null) {
        this.metrics.quotaDenied.inc({ reason: denial.reason });
        context.switchToHttp().getResponse<FastifyReply>().header("retry-after", String(denial.retryAfterSeconds));
        throw new HttpException(`${MESSAGES[denial.reason]} Inténtalo de nuevo en ${denial.retryAfterSeconds} s.`, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    return next.handle();
  }
}
