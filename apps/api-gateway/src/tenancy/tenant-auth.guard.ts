import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { PrismaService } from "../prisma/prisma.service.js";
import { MAX_API_KEY_LENGTH, hashApiKey } from "./api-key.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Tenant dueño de la clave con la que se autenticó la petición (lo pone TenantAuthGuard). */
    tenantId?: string;
  }
}

/** Rutas sin clave: el sondeo del orquestador y las funciones opcionales del servidor (solo booleanos). */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/health", "/v1/capabilities"]);

/** Cada cuánto, como máximo, se vuelve a anotar `lastUsedAt` de una misma clave. */
export const LAST_USED_REFRESH_MS = 60_000;

/**
 * Autenticación por clave de API (ADR 0015). Toma `X-API-Key` (o `Authorization: Bearer`), calcula su SHA-256 y busca
 * el hash en ApiKey. Si la clave existe y no está revocada, deja el tenant en `request.tenantId`; si no, 401.
 *
 * La búsqueda es por igualdad sobre un hash con índice único: no compara la clave en claro, así que no hay una
 * comparación de cadenas cuyo tiempo dependa de cuántos caracteres acertó quien llama. Una caída de la base responde
 * 500 (cerrado), nunca deja pasar.
 */
@Injectable()
export class TenantAuthGuard implements CanActivate {
  private readonly logger = new Logger(TenantAuthGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    if (PUBLIC_PATHS.has(request.url.split("?")[0] ?? "")) return true;

    const candidate = extractKey(request);
    const row =
      candidate === undefined
        ? null
        : await this.prisma.apiKey.findUnique({
            where: { keyHash: hashApiKey(candidate) },
            select: { id: true, tenantId: true, revokedAt: true, lastUsedAt: true },
          });
    if (!row || row.revokedAt !== null) {
      http.getResponse<FastifyReply>().header("WWW-Authenticate", 'Bearer realm="captionforge"');
      throw new UnauthorizedException("Falta la clave del API o no es válida.");
    }

    request.tenantId = row.tenantId;
    this.touch(row.id, row.lastUsedAt);
    return true;
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
