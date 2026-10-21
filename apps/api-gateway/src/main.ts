import "reflect-metadata";

import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { HttpException, Logger, type LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

import { AppModule } from "./app.module.js";
import { type AppConfig, loadConfig } from "./config/config.js";
import { clientKey } from "./security/client-key.js";
import { describePolicy, evaluate } from "./security/request-guard.js";

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
  // La guardia va PRIMERO: los ganchos corren en orden de registro, y ni el CORS ni el límite de uso ni el
  // procesado del cuerpo deben ocurrir para una petición que ya se sabe ajena.
  await registerBrowserGuard(app, config);
  // La interfaz web va ANTES del límite de uso: @fastify/rate-limit solo envuelve las rutas que se registran después de él,
  // así que cargar la interfaz (HTML, CSS, módulos) no gasta el contador de la API de nadie.
  await registerWeb(app, config);
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

/**
 * Defensa frente a páginas ajenas (H10): Host, Origin y Sec-Fetch-Site (ver request-guard.ts), CORS con lista
 * cerrada y cabeceras de seguridad. Sin ALLOWED_ORIGINS no se registra CORS: el API solo responde a su propio origen.
 */
async function registerBrowserGuard(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const { allowedOrigins, allowedHosts } = config.security;
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook("onRequest", async (request, reply) => {
    const verdict = evaluate(
      {
        method: request.method,
        path: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
        secFetchSite: request.headers["sec-fetch-site"] as string | undefined,
      },
      { allowedOrigins, allowedHosts },
    );
    if (verdict === null) return;
    // Misma forma que las excepciones de Nest, para que los clientes vean un solo formato de error.
    const error = verdict.status === 421 ? "Misdirected Request" : "Forbidden";
    // `connection: close`: el cuerpo de la petición rechazada no se lee, así que la conexión no se reutiliza.
    return reply.code(verdict.status).header("connection", "close").send({ statusCode: verdict.status, message: verdict.message, error });
  });

  if (allowedOrigins.length > 0) {
    await app.register(cors, {
      origin: allowedOrigins,
      methods: ["GET", "HEAD", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["Content-Type", "If-Match", "Authorization", "X-API-Key", "Range"],
      exposedHeaders: ["ETag", "Content-Disposition", "Content-Range", "Content-Length", "Accept-Ranges", "Retry-After"],
      credentials: false, // el API no usa cookies: nunca se piden credenciales cross-origin
      maxAge: 600,
    });
  }

  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
  });
}

/**
 * Política de contenido de la interfaz: todo del mismo origen y nada en línea. El cliente es JavaScript de módulos ES
 * sin compilar ni scripts en línea, así que no hace falta 'unsafe-inline' ni 'unsafe-eval' (con una CSP así, un
 * nombre de archivo o un subtítulo que acabara en el HTML no se podría ejecutar). `data:` es para las miniaturas
 * del historial y `blob:` para el <video> con el que se leen la duración y la miniatura antes de subir.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Sirve la interfaz (apps/web/public) desde el propio API: mismo origen, así que no hace falta CORS ni ALLOWED_ORIGINS
 * y la guardia de Host/Origin la deja pasar. `wildcard: false` registra solo los archivos que existen al arrancar:
 * ninguna ruta del API puede acabar en la estática y no hay recorrido de directorios que vigilar. La caché es la de
 * @fastify/static (ETag y revalidación): el gancho de seguridad solo pone `no-store` si falta Cache-Control.
 */
async function registerWeb(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const { webRoot } = config;
  if (webRoot === undefined) return;
  if (!existsSync(webRoot)) {
    new Logger("Web").warn(`WEB_ROOT no existe (${webRoot}): la interfaz no se sirve. Usa WEB_ROOT=off para silenciarlo.`);
    return;
  }
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
    index: "index.html",
    dotfiles: "ignore",
    setHeaders: (reply) => {
      reply.header("Content-Security-Policy", WEB_CSP);
    },
  });
}

/**
 * Rutas caras (subir un video, pedir un quemado): tienen su propio tope y contador. Se decide por la RUTA
 * que Fastify resolvió, no por la URL cruda: `/v1/jobs/%74ranscribe` llega al mismo handler y comparando
 * texto se colaba en el contador general (24 veces más holgado).
 */
const isUpload = (request: FastifyRequest): boolean => {
  const route = request.routeOptions?.url;
  return request.method === "POST" && (route === "/v1/jobs/transcribe" || route === "/v1/jobs/:id/burn");
};

/** /health tiene contador propio y holgado: ya no es una vía libre para martillear la base de datos, Redis y S3. */
const HEALTH_LIMIT_PER_MINUTE = 600;
const isHealth = (request: FastifyRequest): boolean => request.routeOptions?.url === "/health";

/**
 * Límite de peticiones por IP. Las subidas tienen su propio tope y su propio contador: subir un video
 * es lo caro (ancho de banda, S3, cola), y un cliente que consulta el estado cada segundo no debe
 * quedarse sin poder subir. Con TRUST_PROXY=false (por defecto) la IP es la del socket; detrás de un
 * proxy hay que activarlo o todos los clientes comparten la IP del proxy.
 */
async function registerRateLimit(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const { rateLimitPerMinute, uploadRateLimitPerMinute } = config.security;
  if (rateLimitPerMinute === 0 && uploadRateLimitPerMinute === 0) return;
  const limitFor = (request: FastifyRequest): number => {
    if (isHealth(request)) return rateLimitPerMinute === 0 ? 0 : HEALTH_LIMIT_PER_MINUTE;
    return isUpload(request) ? uploadRateLimitPerMinute : rateLimitPerMinute;
  };
  const bucketOf = (request: FastifyRequest): string => (isHealth(request) ? "salud" : isUpload(request) ? "subida" : "api");
  await app.register(rateLimit, {
    global: true,
    timeWindow: "1 minute",
    max: (request) => limitFor(request),
    keyGenerator: (request) => `${bucketOf(request)}:${clientKey(request.ip)}`,
    allowList: (request) => limitFor(request) === 0,
    // HttpException: Nest lo responde como un 429 normal en lugar de registrarlo como error interno.
    errorResponseBuilder: (_request, context) =>
      new HttpException(`Demasiadas peticiones. Inténtalo de nuevo en ${Math.ceil(context.ttl / 1000)} s.`, 429),
  });
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  // La política efectiva queda en el registro: un ALLOWED_HOSTS o ALLOWED_ORIGINS mal puesto se ve al arrancar.
  new Logger("Seguridad").log(`Política de navegador activa — ${describePolicy(config.security)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
