import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { ExternalKeyDecryptError, isExternalProvider, type ExternalProvider } from "../external-keys/external-key-crypto.js";
import { ExternalKeyNotFoundError, ExternalKeysService } from "../external-keys/external-keys.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

const ROUTE = /^\/internal\/v1\/jobs\/([^/]+)\/external-key$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El cuerpo es `{"provider":"openai"}`: 1 KiB sobra, y más se corta sin leerlo. */
const MAX_BODY_BYTES = 1024;
/** Solo estos tipos de trabajo usan claves externas. */
const KEY_KINDS: readonly string[] = ["TRANSLATE", "DUB"];

export interface InternalServerOptions {
  host: string;
  port: number;
  workerToken: string;
  /** Peticiones por minuto en total (0 = sin límite). Cuenta también las que no traen token: frena a quien pruebe tokens. */
  rateLimitPerMinute: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Compara en tiempo constante: se pasa por SHA-256 para igualar las longitudes (timingSafeEqual exige buffers del mismo tamaño). */
function sameToken(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function bearer(request: http.IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/**
 * Lee el cuerpo con tope. Pasado el tope deja de acumular y responde 413 con `Connection: close`: el socket se cierra DESPUÉS de la
 * respuesta (destruirlo antes haría que el cliente viera un reinicio de conexión en lugar del 413).
 */
function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.off("data", onData);
        request.resume(); // descarta lo que falte; requestTimeout corta a quien siga enviando
        reject(new HttpError(413, "body_too_large", "El cuerpo es demasiado grande.", { connection: "close" }));
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseProvider(raw: string): ExternalProvider {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_body", "El cuerpo no es un JSON válido."); // sin repetir lo recibido
  }
  const provider = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { provider?: unknown }).provider : undefined;
  if (!isExternalProvider(provider)) throw new HttpError(400, "invalid_provider", "Proveedor no admitido.");
  return provider;
}

/**
 * Canal interno del worker (ADR 0020), en un puerto APARTE del público, como las métricas: no se publica en el anfitrión ni pasa por
 * Caddy, así que un error del proxy no lo expone. Una sola ruta, `POST /internal/v1/jobs/:jobId/external-key`, con `Authorization:
 * Bearer <WORKER_INTERNAL_TOKEN>`. El espacio sale de la fila del trabajo, NUNCA del cuerpo; el trabajo debe estar RUNNING, ser
 * TRANSLATE o DUB y haber declarado ese proveedor en sus opciones. Con un token filtrado solo se obtienen claves de trabajos en marcha.
 */
export function startInternalServer(app: NestFastifyApplication, options: InternalServerOptions): Promise<http.Server> {
  const keys = app.get(ExternalKeysService);
  const prisma = app.get(PrismaService);
  const logger = new Logger("Interno");
  let windowStart = Date.now();
  let windowCount = 0;

  const send = (response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers }).end(JSON.stringify(body));
  };
  const fail = (response: http.ServerResponse, error: HttpError): void =>
    send(response, error.status, { statusCode: error.status, code: error.code, message: error.message }, error.headers);

  /** Ventana fija de un minuto. Devuelve los segundos de espera si se pasó del máximo. */
  const throttled = (): number | undefined => {
    if (options.rateLimitPerMinute === 0) return undefined;
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount > options.rateLimitPerMinute ? Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000)) : undefined;
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const wait = throttled();
    if (wait !== undefined) throw new HttpError(429, "rate_limited", "Demasiadas peticiones.", { "retry-after": String(wait) });

    const path = (request.url ?? "").split("?")[0] ?? "";
    const match = ROUTE.exec(path);
    if (match === null) throw new HttpError(404, "not_found", "No encontrado.");
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Método no permitido.", { allow: "POST" });

    const token = bearer(request);
    if (token === undefined || !sameToken(token, options.workerToken)) {
      logger.warn("Petición interna rechazada: token ausente o incorrecto.");
      throw new HttpError(401, "unauthorized", "No autorizado.", { "www-authenticate": 'Bearer realm="captionforge-internal"' });
    }

    const jobId = match[1]!;
    if (!UUID.test(jobId)) throw new HttpError(400, "invalid_job_id", "Identificador de trabajo inválido.");
    const provider = parseProvider(await readBody(request));
    if (!keys.enabled) throw new HttpError(503, "byok_disabled", "Las claves externas propias no están activadas en este servidor.");

    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { kind: true, status: true, tenantId: true, options: true } });
    if (job === null) throw new HttpError(404, "job_not_found", "El trabajo no existe.");
    if (job.status !== "RUNNING") throw new HttpError(403, "job_not_running", "El trabajo no está en curso.");
    if (!KEY_KINDS.includes(job.kind)) throw new HttpError(403, "job_kind_forbidden", "Este tipo de trabajo no usa claves externas.");
    const declared = typeof job.options === "object" && job.options !== null && !Array.isArray(job.options) ? (job.options as { provider?: unknown }).provider : undefined;
    if (declared !== provider) throw new HttpError(403, "provider_mismatch", "El trabajo no declara ese proveedor.");

    let revealed: { key: string; baseUrl?: string; model?: string };
    try {
      revealed = await keys.reveal(job.tenantId, provider);
    } catch (error) {
      if (error instanceof ExternalKeyNotFoundError) throw new HttpError(404, "external_key_not_found", "El espacio no tiene una clave guardada para ese proveedor.");
      throw error;
    }
    logger.log(`Clave ${provider} entregada al worker: trabajo ${jobId}, espacio ${job.tenantId}`); // jamás el valor
    send(response, 200, revealed); // { key }, con baseUrl y model si el espacio los guardó (ADR 0022)
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) return fail(response, error);
      // Solo el tipo del error: ni el mensaje ni la traza, que podrían arrastrar texto de la clave.
      logger.error(`Error al entregar una clave: ${error instanceof ExternalKeyDecryptError ? "no se pudo descifrar" : error instanceof Error ? error.name : "desconocido"}`);
      fail(response, new HttpError(500, "internal_error", "Error interno."));
    });
  });
  // Un cliente lento no retiene el listener: los encabezados y el cuerpo llegan en segundos o se corta.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
