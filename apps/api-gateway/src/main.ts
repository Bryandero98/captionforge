import "reflect-metadata";

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { randomUUID } from "node:crypto";
import { HttpException, Logger, type LoggerService, type LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

import { AppModule } from "./app.module.js";
import { type AppConfig, loadConfig } from "./config/config.js";
import { JsonLogger } from "./observability/json-logger.js";
import { MetricsService } from "./observability/metrics.service.js";
import { startMetricsServer } from "./observability/metrics-server.js";
import { clientKey } from "./security/client-key.js";
import { describePolicy, evaluate } from "./security/request-guard.js";

export async function createApp(
  config: AppConfig,
  options: { logger?: LogLevel[] | false | LoggerService } = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    // bodyLimit solo afecta a los cuerpos JSON (ediciones de subtítulos, opciones de quemado); las
    // subidas van por multipart y tienen su propio límite.
    new FastifyAdapter({ bodyLimit: 4 * 1024 * 1024, trustProxy: config.security.trustProxy, genReqId: requestId }),
    { logger: options.logger ?? (config.observability.logFormat === "json" ? new JsonLogger() : ["error", "warn", "log"]) },
  );
  registerObservability(app, config);
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

/** Identificador de petición: el de Caddy (`X-Request-Id`) si es razonable; si no, uno nuevo. Nada de texto libre en los registros. */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
function requestId(request: { headers: Record<string, string | string[] | undefined> }): string {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && REQUEST_ID.test(header) ? header : randomUUID();
}

/**
 * Métricas y registro de cada petición (ADR 0018). Se registra ANTES de la guardia de navegador para que también cuenten las
 * peticiones rechazadas. La ruta es el PATRÓN (`/v1/jobs/:id`), nunca la URL: así ni los ids ni la cadena de consulta
 * (códigos de OAuth) llegan a los registros ni a las etiquetas de las métricas. Cabeceras, cookies y cuerpo no se registran.
 */
function registerObservability(app: NestFastifyApplication, config: AppConfig): void {
  const fastify = app.getHttpAdapter().getInstance();
  const logger = new Logger("HTTP");
  let cached: MetricsService | undefined;
  fastify.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });
  fastify.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "no_encontrada";
    const seconds = reply.elapsedTime / 1000;
    const metrics: MetricsService = cached ?? (cached = app.get(MetricsService) as MetricsService);
    metrics.httpRequests.inc({ method: request.method, route, status: String(reply.statusCode) });
    metrics.httpDuration.observe({ method: request.method, route }, seconds);
    if (config.observability.logRequests && route !== "/health") {
      logger.log({
        event: "http_request",
        requestId: request.id,
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        tenantId: request.tenantId,
        ip: request.ip,
      });
    }
  });
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
    return reply.code(verdict.status).send({ statusCode: verdict.status, message: verdict.message, error });
  });

  if (allowedOrigins.length > 0) {
    await app.register(cors, {
      origin: allowedOrigins,
      methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "If-Match", "Authorization", "X-API-Key", "X-Requested-With", "Range"],
      exposedHeaders: ["ETag", "Content-Disposition", "Content-Range", "Content-Length", "Accept-Ranges", "Retry-After"],
      credentials: false, // el API no usa cookies: nunca se piden credenciales cross-origin
      maxAge: 600,
    });
  }

  fastify.addHook("onSend", async (request, reply) => {
    // Rechazo con el cuerpo de la petición sin leer (413, 408, 403, 421, 429...): ver discardRemainingBody.
    if (reply.statusCode >= 400 && !request.raw.complete) discardRemainingBody(request.raw);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
  });
}

/** Cuánto del cuerpo restante se descarta tras un rechazo, y durante cuánto tiempo, antes de cortar la conexión. */
export const DISCARD_LIMIT_BYTES = 16 * 1024 * 1024;
export const DISCARD_TIMEOUT_MS = 10_000;

/**
 * Tras responder un error con el cuerpo sin leer, cerrar la conexión de golpe (o con `connection: close`) no sirve: el cliente sigue enviando, el
 * sistema operativo responde con un reinicio de la conexión y el navegador pierde la respuesta (verías un «error de
 * red» en lugar del 413). Y no cerrarla deja al cliente atascado contra una conexión que nadie lee. Se hace lo que
 * nginx con su «lingering close»: se lee y descarta el resto con tope de bytes y de tiempo, y entonces se corta.
 */
function discardRemainingBody(request: FastifyRequest["raw"]): void {
  if (request.destroyed || request.readableEnded) return; // el cliente ya cortó: no hay nada que vaciar ni temporizador que armar
  let discarded = 0;
  const cut = (): void => {
    request.destroy();
  };
  const timer = setTimeout(cut, DISCARD_TIMEOUT_MS);
  timer.unref();
  request.once("close", () => clearTimeout(timer));
  request.on("data", (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > DISCARD_LIMIT_BYTES) cut();
  });
  request.resume();
}

/**
 * Política de contenido de la interfaz: todo del mismo origen y nada en línea. El cliente es JavaScript de módulos ES
 * sin compilar ni scripts en línea, así que no hace falta 'unsafe-inline' ni 'unsafe-eval' (con una CSP así, un
 * nombre de archivo o un subtítulo que acabara en el HTML no se podría ejecutar). `data:` es para la flecha de los
 * <select> (un SVG en el CSS). `blob:` en media-src es para la vista previa del video quemado: un <video src> no puede mandar
 * la clave de API, así que la interfaz lo baja con fetch y lo muestra desde un Blob (ADR 0015).
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
  // Se sirve TODO lo que haya bajo la raíz, sin clave de API ni límite de uso: exigir un index.html evita servir por
  // error una carpeta cualquiera (WEB_ROOT=. o /) con código fuente, esquemas y dependencias.
  if (!existsSync(join(webRoot, "index.html"))) {
    new Logger("Web").warn(`WEB_ROOT (${webRoot}) no tiene index.html: la interfaz no se sirve. Usa WEB_ROOT=off para silenciarlo.`);
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
  registerWebConfig(app, config);
}

/**
 * Clave por defecto de la interfaz local (ADR 0015). El MVP no tiene inicio de sesión: la interfaz pide su configuración
 * a este endpoint y manda la clave en `X-API-Key`. Quien alcanza el puerto obtiene la clave del tenant "Default", igual
 * que antes podía usar el API abierto en 127.0.0.1: por eso solo existe si se define WEB_API_KEY, y la guardia de
 * Host/Origin/Sec-Fetch-Site (que corre antes) impide que una página ajena la lea desde el navegador. El inicio de
 * sesión de personas (issue #7) la sustituye.
 */
function registerWebConfig(app: NestFastifyApplication, config: AppConfig): void {
  const apiKey = config.security.webApiKey;
  if (apiKey === undefined) return;
  app
    .getHttpAdapter()
    .getInstance()
    .get("/web-config.json", async (_request, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("Content-Security-Policy", WEB_CSP)
        .type("application/json; charset=utf-8");
      return { apiKey };
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
  if (config.observability.metricsPort > 0) {
    await startMetricsServer(app, { host: config.observability.metricsHost, port: config.observability.metricsPort });
    new Logger("Métricas").log(`Métricas en ${config.observability.metricsHost}:${config.observability.metricsPort}/metrics (red interna; no se publica)`);
  }
  // La política efectiva queda en el registro: un ALLOWED_HOSTS o ALLOWED_ORIGINS mal puesto se ve al arrancar.
  new Logger("Seguridad").log(`Política de navegador activa — ${describePolicy(config.security)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
