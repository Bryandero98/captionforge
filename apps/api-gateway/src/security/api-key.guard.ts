import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import { APP_CONFIG, type AppConfig } from "../config/config.js";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * Clave compartida opcional (API_KEY). Sin ella el API queda abierto, que solo es aceptable en
 * 127.0.0.1 (el valor por defecto de HOST). Pensada para un despliegue detrás de otro servicio o de un
 * proxy; la autenticación de personas usuarias es una decisión del cliente web y no está aquí.
 *
 * Acepta `Authorization: Bearer <clave>` o `X-API-Key: <clave>`. /health queda abierto para los
 * sondeos del orquestador. La comparación es de tiempo constante (sobre los hash, así tampoco
 * revela la longitud de la clave).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected: Buffer | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.expected = config.security.apiKey === undefined ? undefined : digest(config.security.apiKey);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.expected === undefined) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    if (request.url.split("?")[0] === "/health") return true;

    const candidate = extractKey(request);
    if (candidate !== undefined && timingSafeEqual(digest(candidate), this.expected)) return true;

    http.getResponse<FastifyReply>().header("WWW-Authenticate", 'Bearer realm="captionforge"');
    throw new UnauthorizedException("Falta la clave del API o no es válida.");
  }
}

function extractKey(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const header = request.headers["x-api-key"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}
