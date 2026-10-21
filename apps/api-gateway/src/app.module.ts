import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { APP_CONFIG, type AppConfig } from "./config/config.js";
import { HealthController } from "./health/health.controller.js";
import { JobsController } from "./jobs/jobs.controller.js";
import { JobsService } from "./jobs/jobs.service.js";
import { ReaperService } from "./jobs/reaper.service.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { QueueService } from "./queue/queue.service.js";
import { ApiKeyGuard } from "./security/api-key.guard.js";
import { StorageService } from "./storage/storage.service.js";

@Module({})
export class AppModule {
  /** La configuración se inyecta desde fuera para poder cambiarla en las pruebas. */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, JobsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        PrismaService,
        StorageService,
        QueueService,
        JobsService,
        ReaperService,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    };
  }
}
