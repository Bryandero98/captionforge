import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import { JobIdPipe } from "../jobs/job-id.pipe.js";
import type { Role } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { displayPrefix, generateApiKey, hashApiKey } from "../tenancy/api-key.js";
import { MinRole } from "../tenancy/roles.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { OptionalSessionUserId, SessionId, SessionUserId, TenantId } from "../tenancy/tenant-auth.guard.js";

/** Tope de claves activas por tenant: un escudo operativo, no un límite de producto. */
export const MAX_ACTIVE_KEYS = 20;
const MAX_NAME = 60;

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** La cuenta de quien tiene la sesión (o la clave) y sus claves de API. Todo filtrado por el tenant de la petición. */
@Controller("v1")
export class AccountController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** Quién soy. Con clave de API solo hay tenant (las claves no son de una persona). */
  @Get("me")
  async me(@TenantId() tenantId: string, @OptionalSessionUserId() userId: string | undefined, @Req() request: FastifyRequest): Promise<{ tenant: { id: string; name: string }; role: Role | null; user: { id: string; name: string | null; email: string | null; provider: string | null } | null }> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true } });
    const user = userId === undefined ? null : await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, provider: true } });
    return { tenant, role: request.role ?? null, user };
  }

  /** Cambia el espacio de trabajo activo de ESTA sesión (ADR 0019). Cualquier miembro puede: pide solo Lector, no Editor. */
  @Post("me/workspace")
  @HttpCode(200)
  @MinRole("VIEWER")
  switchWorkspace(@SessionUserId() userId: string, @SessionId() sessionId: string, @Body() body: unknown) {
    return this.workspaces.switchWorkspace(sessionId, userId, body);
  }

  @Get("keys")
  @MinRole("OWNER")
  async list(@TenantId() tenantId: string, @SessionUserId() _userId: string): Promise<{ keys: KeyView[] }> {
    const rows = await this.prisma.apiKey.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 });
    return { keys: rows.map(toView) };
  }

  /** Crea una clave. El valor completo se devuelve UNA vez, en esta respuesta: después solo existe su hash. */
  @Post("keys")
  @HttpCode(201)
  @MinRole("OWNER")
  async create(@TenantId() tenantId: string, @SessionUserId() _userId: string, @Body() body: unknown): Promise<KeyView & { key: string }> {
    const name = (body as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_NAME) {
      throw new BadRequestException(`name debe ser un texto de 1 a ${MAX_NAME} caracteres.`);
    }
    const active = await this.prisma.apiKey.count({ where: { tenantId, revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) throw new ConflictException(`Ya tienes ${MAX_ACTIVE_KEYS} claves activas. Revoca alguna antes de crear otra.`);
    const key = generateApiKey();
    const row = await this.prisma.apiKey.create({ data: { id: randomUUID(), tenantId, name: name.trim(), prefix: displayPrefix(key), keyHash: hashApiKey(key) } });
    return { ...toView(row), key };
  }

  /** Revoca una clave del tenant (deja de valer en la siguiente petición). 404 si no es suya, como todo lo ajeno. */
  @Delete("keys/:id")
  @HttpCode(204)
  @MinRole("OWNER")
  async revoke(@TenantId() tenantId: string, @SessionUserId() _userId: string, @Param("id", JobIdPipe) id: string): Promise<void> {
    const found = await this.prisma.apiKey.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!found) throw new NotFoundException("No existe esa clave.");
    await this.prisma.apiKey.updateMany({ where: { id, tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

function toView(row: { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }): KeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
