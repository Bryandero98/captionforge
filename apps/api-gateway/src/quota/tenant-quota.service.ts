import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { MetricsService } from "../observability/metrics.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** Motivo por el que una cuota niega la petición y cuántos segundos conviene esperar. */
export type QuotaDenial = { reason: "uploads" | "queue"; retryAfterSeconds: number };

const HOUR_MS = 3_600_000;
/** Un error de Redis se registra como mucho una vez por este tiempo: una caída no debe llenar el registro. */
const LOG_EVERY_MS = 30_000;
const RETRY_QUEUE_SECONDS = 30;

// Contador de ventana fija atómico: INCR y PEXPIRE en un solo paso; si fueran dos llamadas, una caída entre ambas
// dejaría la clave sin vencimiento para siempre.
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

/**
 * Cuotas por tenant (ADR 0017). Subidas por hora: contador en Redis. Trabajos en curso: se cuentan en PostgreSQL, que es
 * la fuente de verdad del estado (el worker los termina sin avisar al API, así que un contador en Redis se desviaría).
 *
 * Fail-open: si Redis no responde se registra el error y la petición PASA. La cuota es un escudo operativo, no una
 * barrera de seguridad; el aislamiento entre tenants no depende de ella.
 */
@Injectable()
export class TenantQuotaService implements OnModuleDestroy {
  private readonly logger = new Logger("Cuotas");
  private readonly client: Redis;
  private lastLoggedAt = 0;
  /** Cuántas veces Redis falló y se dejó pasar; también lo lee /metrics. */
  failures = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      // Caída = error inmediato, no una cola de comandos esperando: la subida no debe quedar colgada por la cuota.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      connectTimeout: 1000,
    });
    this.client.on("error", (error: Error) => this.noteFailure(error));
  }

  /** Subida nueva: primero la cola (barata, sin consumir cuota) y luego el contador por hora. null = permitida. */
  async checkUpload(tenantId: string): Promise<QuotaDenial | null> {
    return (await this.checkQueue(tenantId)) ?? (await this.consumeUpload(tenantId));
  }

  /** ¿Tiene el tenant demasiados trabajos esperando o ejecutándose? */
  async checkQueue(tenantId: string): Promise<QuotaDenial | null> {
    const max = this.config.security.tenantMaxQueuedJobs;
    if (max === 0) return null;
    const inFlight = await this.prisma.job.count({ where: { tenantId, status: { in: ["QUEUED", "RUNNING"] } } });
    return inFlight >= max ? { reason: "queue", retryAfterSeconds: RETRY_QUEUE_SECONDS } : null;
  }

  private async consumeUpload(tenantId: string): Promise<QuotaDenial | null> {
    const max = this.config.security.tenantUploadsPerHour;
    if (max === 0) return null;
    const bucket = Math.floor(Date.now() / HOUR_MS);
    try {
      const [count, ttlMs] = (await this.client.eval(COUNT_SCRIPT, 1, `captionforge:quota:${tenantId}:uploads:${bucket}`, String(HOUR_MS))) as [number, number];
      if (count <= max) return null;
      return { reason: "uploads", retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
    } catch (error) {
      this.noteFailure(error);
      return null; // fail-open
    }
  }

  private noteFailure(error: unknown): void {
    this.failures += 1;
    this.metrics.quotaRedisFailures.inc();
    const now = Date.now();
    if (now - this.lastLoggedAt < LOG_EVERY_MS) return;
    this.lastLoggedAt = now;
    this.logger.error(`Redis no responde; se deja pasar el tráfico sin cuota por tenant: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Solo para pruebas: corta este cliente de Redis sin tocar la cola de BullMQ. */
  simulateOutage(): void {
    this.client.disconnect();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
