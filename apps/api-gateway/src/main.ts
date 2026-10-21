import "reflect-metadata";

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";

import { AppModule } from "./app.module.js";
import { type AppConfig, loadConfig } from "./config/config.js";

export async function createApp(
  config: AppConfig,
  options: { logger?: LogLevel[] | false } = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    // bodyLimit solo afecta a los cuerpos JSON (ediciones de subtítulos, opciones de quemado); las
    // subidas van por multipart y tienen su propio límite.
    new FastifyAdapter({ bodyLimit: 4 * 1024 * 1024 }),
    { logger: options.logger ?? ["error", "warn", "log"] },
  );
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 4,
      fieldSize: 16 * 1024,
      // Tope de seguridad de la librería; el límite exacto (413) lo aplica StorageService.
      fileSize: config.maxUploadBytes + 1024 * 1024,
    },
  });
  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
