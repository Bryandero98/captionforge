import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { APP_CONFIG, type AppConfig } from "./config/config.js";
import { AccountController } from "./auth/account.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { CapabilitiesController } from "./capabilities/capabilities.controller.js";
import { HealthController } from "./health/health.controller.js";
import { JobsController } from "./jobs/jobs.controller.js";
import { JobsService } from "./jobs/jobs.service.js";
import { ReaperService } from "./jobs/reaper.service.js";
import { MetricsService } from "./observability/metrics.service.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { QueueService } from "./queue/queue.service.js";
import { TenantQuotaInterceptor } from "./quota/tenant-quota.interceptor.js";
import { TenantQuotaService } from "./quota/tenant-quota.service.js";
import { ConnectionLimits } from "./security/connection-limits.js";
import { StorageService } from "./storage/storage.service.js";
import { TenantAuthGuard } from "./tenancy/tenant-auth.guard.js";

@Module({})
export class AppModule {
  /** La configuración se inyecta desde fuera para poder cambiarla en las pruebas. */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, CapabilitiesController, AuthController, AccountController, JobsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        PrismaService,
        StorageService,
        QueueService,
        JobsService,
        AuthService,
        ReaperService,
        ConnectionLimits,
        MetricsService,
        TenantQuotaService,
        TenantQuotaInterceptor,
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    };
  }
}
