import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service.js";
import { SESSION_COOKIE, cookieName, readCookie } from "../auth/cookies.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MAX_API_KEY_LENGTH, hashApiKey } from "./api-key.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Tenant dueño de la clave de API o de la sesión con la que se autenticó la petición (lo pone TenantAuthGuard). */
    tenantId?: string;
    /** Persona de la sesión de navegador; no existe con una clave de API (esas son del tenant, no de una persona). */
    userId?: string;
  }
}

/** Rutas sin autenticación: sondeos, funciones opcionales (solo booleanos) y el propio inicio de sesión. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/health", "/v1/capabilities"]);
const isPublic = (path: string): boolean => PUBLIC_PATHS.has(path) || path.startsWith("/auth/");

/** Cada cuánto, como máximo, se vuelve a anotar `lastUsedAt` de una misma clave. */
export const LAST_USED_REFRESH_MS = 60_000;

/**
 * Cabecera que el cliente web pone en toda petición que MODIFICA con sesión de navegador. Un formulario o un `fetch` simple de otra
 * página no puede añadirla sin un preflight de CORS (que el API no concede salvo a ALLOWED_ORIGINS): es una defensa más contra
 * CSRF, además de SameSite=Lax y de la guardia de Origin/Sec-Fetch-Site.
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "captionforge";
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Autenticación (ADR 0015 y 0016). Dos vías, en este orden:
 *  1. Clave de API (`X-API-Key` o `Authorization: Bearer`): su SHA-256 se busca en ApiKey. Es para scripts y servicios.
 *  2. Sesión de navegador (cookie): su SHA-256 se busca en Session. Es para la interfaz web.
 * Si la petición trae una clave, solo cuenta la clave: no se «cae» a la cookie con una clave inválida. Resultado: `request.tenantId`
 * (y `request.userId` con sesión); si no, 401. Una caída de la base responde 500 (cierra), nunca deja pasar.
 */
@Injectable()
export class TenantAuthGuard implements CanActivate {
  private readonly logger = new Logger(TenantAuthGuard.name);
  private readonly secure: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.secure = config.auth.publicUrl.startsWith("https:");
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    if (isPublic(request.url.split("?")[0] ?? "")) return true;

    const candidate = extractKey(request);
    if (candidate !== undefined || hasKeyHeader(request)) {
      const row =
        candidate === undefined
          ? null
          : await this.prisma.apiKey.findUnique({
              where: { keyHash: hashApiKey(candidate) },
              select: { id: true, tenantId: true, revokedAt: true, lastUsedAt: true },
            });
      if (!row || row.revokedAt !== null) throw this.unauthorized(http.getResponse<FastifyReply>());
      request.tenantId = row.tenantId;
      this.touch(row.id, row.lastUsedAt);
      return true;
    }

    const token = readCookie(request.headers.cookie, cookieName(SESSION_COOKIE, this.secure));
    const session = token === undefined ? null : await this.auth.findSession(token);
    if (session === null) throw this.unauthorized(http.getResponse<FastifyReply>());
    if (!SAFE_METHODS.has(request.method.toUpperCase()) && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new ForbiddenException("Falta la cabecera de la interfaz en una petición que modifica datos.");
    }
    request.tenantId = session.tenantId;
    request.userId = session.userId;
    return true;
  }

  private unauthorized(reply: FastifyReply): UnauthorizedException {
    reply.header("WWW-Authenticate", 'Bearer realm="captionforge"');
    return new UnauthorizedException("Falta la clave del API o no es válida.");
  }

  /** Fire-and-forget: anotar el uso no retrasa la petición ni la hace fallar. Se limita a una escritura por minuto y clave. */
  private touch(id: string, lastUsedAt: Date | null): void {
    const now = Date.now();
    if (lastUsedAt !== null && now - lastUsedAt.getTime() < LAST_USED_REFRESH_MS) return;
    this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date(now) }, select: { id: true } }).catch((error: unknown) => {
      this.logger.warn(`No se pudo anotar lastUsedAt de la clave ${id}: ${(error as Error).message}`);
    });
  }
}

/** ¿Trae la petición alguna cabecera de clave, aunque sea inválida? Entonces no se mira la cookie. */
function hasKeyHeader(request: FastifyRequest): boolean {
  const header = request.headers["x-api-key"];
  return (typeof header === "string" && header.trim() !== "") || (typeof request.headers.authorization === "string" && /^Bearer\s/i.test(request.headers.authorization));
}

function extractKey(request: FastifyRequest): string | undefined {
  const header = request.headers["x-api-key"];
  let key: string | undefined = typeof header === "string" ? header.trim() : undefined;
  if (!key) {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
    key = match?.[1];
  }
  return key && key.length <= MAX_API_KEY_LENGTH ? key : undefined;
}

/**
 * El tenant de la petición. Una ruta protegida siempre lo tiene; si falta es un fallo de configuración (una ruta
 * pública que lo pide) y se responde 401 en lugar de seguir sin filtro de tenant.
 */
export const TenantId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const tenantId = context.switchToHttp().getRequest<FastifyRequest>().tenantId;
  if (tenantId === undefined) throw new UnauthorizedException("Falta la clave del API o no es válida.");
  return tenantId;
});

/** La persona de la sesión de navegador: las rutas que la usan (claves de API) no aceptan una clave de API. */
export const SessionUserId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const userId = context.switchToHttp().getRequest<FastifyRequest>().userId;
  if (userId === undefined) throw new ForbiddenException("Esta operación pide una sesión iniciada en la interfaz, no una clave de API.");
  return userId;
});

/** La persona de la sesión si la hay (con una clave de API no existe), sin fallar. */
export const OptionalSessionUserId = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  return context.switchToHttp().getRequest<FastifyRequest>().userId;
});
