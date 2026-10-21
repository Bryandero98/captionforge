import "reflect-metadata";

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { HttpException, type LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

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
    new FastifyAdapter({ bodyLimit: 4 * 1024 * 1024, trustProxy: config.security.trustProxy }),
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
  await registerRateLimit(app, config);
  app.enableShutdownHooks();
  return app;
}

const isUpload = (request: FastifyRequest): boolean =>
  request.method === "POST" && request.url.split("?")[0] === "/v1/jobs/transcribe";

/**
 * Límite de peticiones por IP. Las subidas tienen su propio tope y su propio contador: subir un video
 * es lo caro (ancho de banda, S3, cola), y un cliente que consulta el estado cada segundo no debe
 * quedarse sin poder subir. Con TRUST_PROXY=false (por defecto) la IP es la del socket; detrás de un
 * proxy hay que activarlo o todos los clientes comparten la IP del proxy.
 */
async function registerRateLimit(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const { rateLimitPerMinute, uploadRateLimitPerMinute } = config.security;
  if (rateLimitPerMinute === 0 && uploadRateLimitPerMinute === 0) return;
  const limitFor = (request: FastifyRequest): number => (isUpload(request) ? uploadRateLimitPerMinute : rateLimitPerMinute);
  await app.register(rateLimit, {
    global: true,
    timeWindow: "1 minute",
    max: (request) => limitFor(request),
    keyGenerator: (request) => `${isUpload(request) ? "subida" : "api"}:${request.ip}`,
    allowList: (request) => request.url.split("?")[0] === "/health" || limitFor(request) === 0,
    // HttpException: Nest lo responde como un 429 normal en lugar de registrarlo como error interno.
    errorResponseBuilder: (_request, context) =>
      new HttpException(`Demasiadas peticiones. Inténtalo de nuevo en ${Math.ceil(context.ttl / 1000)} s.`, 429),
  });
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
