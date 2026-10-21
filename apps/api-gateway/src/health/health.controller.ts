import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";
import { QueueService } from "../queue/queue.service.js";
import { StorageService } from "../storage/storage.service.js";

type Check = "up" | "down";

@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly storage: StorageService,
  ) {}

  /** 200 si PostgreSQL, Redis y S3 responden; 503 si no. Nunca devuelve el texto de los errores. */
  @Get()
  async check(): Promise<{ status: "ok"; checks: Record<string, Check> }> {
    const probe = async (fn: () => Promise<unknown>): Promise<Check> => {
      try {
        await fn();
        return "up";
      } catch {
        return "down";
      }
    };
    const [database, redis, s3] = await Promise.all([
      probe(() => this.prisma.$queryRaw`SELECT 1`),
      probe(() => this.queue.ping()),
      probe(() => this.storage.ping()),
    ]);
    const checks = { database, redis, s3 };
    if (Object.values(checks).includes("down")) {
      throw new ServiceUnavailableException({ status: "error", checks });
    }
    return { status: "ok", checks };
  }
}
