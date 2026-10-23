import { Inject, Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";

const JOB_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

/**
 * Métricas de Prometheus (ADR 0018). Cada aplicación tiene su propio registro, no el global: las pruebas crean varias
 * aplicaciones en un mismo proceso. Las etiquetas son siempre de cardinalidad acotada: método, PATRÓN de ruta (nunca la URL
 * con ids), estado HTTP y motivo de cuota. Nada de tenants, claves ni IP: una métrica no es un registro de personas.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequests: Counter<"method" | "route" | "status">;
  readonly httpDuration: Histogram<"method" | "route">;
  readonly quotaDenied: Counter<"reason">;
  readonly quotaRedisFailures: Counter;
  readonly logins: Counter<"provider" | "result">;

  constructor(
    @Inject(APP_CONFIG) _config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = new Counter({ name: "captionforge_http_requests_total", help: "Peticiones HTTP por método, ruta (patrón) y estado.", labelNames: ["method", "route", "status"], registers });
    this.httpDuration = new Histogram({
      name: "captionforge_http_request_duration_seconds",
      help: "Duración de las peticiones HTTP.",
      labelNames: ["method", "route"],
      buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 10, 60],
      registers,
    });
    this.quotaDenied = new Counter({ name: "captionforge_quota_denied_total", help: "Peticiones negadas por la cuota de un tenant.", labelNames: ["reason"], registers });
    this.quotaRedisFailures = new Counter({ name: "captionforge_quota_redis_failures_total", help: "Veces que Redis falló y la cuota se dejó pasar (fail-open).", registers });
    this.logins = new Counter({ name: "captionforge_logins_total", help: "Inicios de sesión por proveedor y resultado.", labelNames: ["provider", "result"], registers });
    new Gauge({
      name: "captionforge_jobs",
      help: "Trabajos por estado (de PostgreSQL, la fuente de verdad).",
      labelNames: ["status"],
      registers,
      collect: async () => {
        const rows = await this.prisma.job.groupBy({ by: ["status"], _count: { _all: true } });
        const gauge = this.registry.getSingleMetric("captionforge_jobs") as Gauge<"status">;
        const counts = new Map(rows.map((row) => [row.status as string, row._count._all]));
        for (const status of JOB_STATUSES) gauge.set({ status }, counts.get(status) ?? 0);
      },
    });
    // Los contadores sin eventos todavía aparecen en 0 en lugar de faltar: una alerta sobre «sube» necesita la serie.
    this.quotaRedisFailures.inc(0);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
