import { BadRequestException, ConflictException, GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { Prisma } from "../generated/prisma/client.js";
import type { Role } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { satisfies } from "../tenancy/roles.js";

/** Vigencia de una invitación (ADR 0019). */
export const INVITE_TTL_MS = 7 * 86_400_000;
/** Tope de invitaciones sin usar por espacio: un escudo operativo, no un límite de producto. */
export const MAX_PENDING_INVITES = 50;
/** `cfi_` + 256 bits en base64url (43 caracteres). El formato se valida ANTES de tocar la base. */
const INVITE_TOKEN = /^cfi_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly Role[] = ["OWNER", "EDITOR", "VIEWER"];

const hashToken = (token: string): string => createHash("sha256").update(token).digest("base64url");

export interface InviteView {
  id: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

/** Equipos (ADR 0019): invitaciones, miembros y espacio activo. Todo se filtra por el espacio de la petición. */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── invitaciones ──────────────────────────────────────────────────────────────────────────────

  /** El Dueño crea un enlace de un solo uso. El token completo se devuelve UNA vez: en la base solo queda su hash. */
  async createInvite(tenantId: string, createdBy: string, body: unknown): Promise<InviteView & { link: string }> {
    const role = parseRole(body);
    if (role === "OWNER") throw new BadRequestException("No se puede invitar como Dueño: invita como Editor o Lector y promueve después.");
    const now = new Date();
    const pending = await this.prisma.invitation.count({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } });
    if (pending >= MAX_PENDING_INVITES) throw new ConflictException(`Ya hay ${MAX_PENDING_INVITES} invitaciones pendientes. Revoca alguna antes de crear otra.`);

    const token = `cfi_${randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.invitation.create({
      data: { id: randomUUID(), tenantId, role, tokenHash: hashToken(token), createdBy, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) },
    });
    return { ...toInviteView(row), link: `${this.config.auth.publicUrl}/?invite=${token}` };
  }

  /** Las invitaciones vigentes del espacio (sin usar, sin revocar y sin vencer). Nunca incluye el token. */
  async listInvites(tenantId: string): Promise<{ invites: InviteView[] }> {
    const rows = await this.prisma.invitation.findMany({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: MAX_PENDING_INVITES });
    return { invites: rows.map(toInviteView) };
  }

  /** Revoca una invitación del espacio. 404 si no es de este espacio, como todo lo ajeno. Revocar una ya usada no hace nada. */
  async revokeInvite(tenantId: string, id: string): Promise<void> {
    const found = await this.prisma.invitation.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!found) throw new NotFoundException("No existe esa invitación.");
    await this.prisma.invitation.updateMany({ where: { id, tenantId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /**
   * Consume una invitación. El token se «reclama» con un UPDATE condicional: la base garantiza que de dos aceptaciones simultáneas
   * solo una encuentra la fila libre. Todo va en una transacción: si algo falla después, el token NO se gasta.
   * No baja de rango a nadie (un Dueño que acepta una invitación de Lector sigue siendo Dueño) pero sí sube.
   */
  async acceptInvite(userId: string, token: string): Promise<{ tenant: { id: string; name: string }; role: Role }> {
    if (!INVITE_TOKEN.test(token)) throw new NotFoundException("Esa invitación no existe.");
    const tokenHash = hashToken(token);
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.invitation.updateMany({ where: { tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now, acceptedBy: userId } });
      if (claimed.count === 0) {
        const exists = await tx.invitation.findUnique({ where: { tokenHash }, select: { id: true } });
        if (!exists) throw new NotFoundException("Esa invitación no existe.");
        throw new GoneException("Esa invitación ya se usó, venció o fue revocada. Pide un enlace nuevo.");
      }
      const invitation = await tx.invitation.findUniqueOrThrow({ where: { tokenHash }, select: { tenantId: true, role: true, tenant: { select: { id: true, name: true } } } });
      const existing = await tx.membership.findUnique({ where: { userId_tenantId: { userId, tenantId: invitation.tenantId } }, select: { role: true } });
      let role = invitation.role;
      if (existing === null) {
        await tx.membership.create({ data: { userId, tenantId: invitation.tenantId, role } });
      } else if (satisfies(existing.role, invitation.role)) {
        role = existing.role;
      } else {
        await tx.membership.update({ where: { userId_tenantId: { userId, tenantId: invitation.tenantId } }, data: { role } });
      }
      return { tenant: invitation.tenant, role };
    });
  }

  // ── miembros ──────────────────────────────────────────────────────────────────────────────────

  async listMembers(tenantId: string): Promise<{ members: { userId: string; name: string | null; email: string | null; provider: string | null; role: Role; joinedAt: string }[] }> {
    const rows = await this.prisma.membership.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { role: true, createdAt: true, user: { select: { id: true, name: true, email: true, provider: true } } } });
    return { members: rows.map((row) => ({ userId: row.user.id, name: row.user.name, email: row.user.email, provider: row.user.provider, role: row.role, joinedAt: row.createdAt.toISOString() })) };
  }

  /** Cambia el rol de un miembro del espacio. Nunca deja el espacio sin Dueño (regla del Último Dueño). */
  async setMemberRole(tenantId: string, targetId: string, body: unknown): Promise<{ userId: string; role: Role }> {
    const role = parseRole(body);
    await this.changeMembership(tenantId, targetId, (current, owners) => {
      if (current === "OWNER" && role !== "OWNER" && owners <= 1) throw lastOwner();
      return { role };
    });
    return { userId: targetId, role };
  }

  /** Quita a un miembro. Nunca deja el espacio sin Dueño. */
  async removeMember(tenantId: string, targetId: string): Promise<void> {
    await this.changeMembership(tenantId, targetId, (current, owners) => {
      if (current === "OWNER" && owners <= 1) throw lastOwner();
      return null;
    });
  }

  /**
   * La regla del Último Dueño, a prueba de carreras: dentro de una transacción se BLOQUEAN las filas de los Dueños del espacio
   * (siempre en el mismo orden, para que dos transacciones no se bloqueen entre sí) y solo entonces se cuenta. Sin el bloqueo, dos
   * Dueños que se degradan a la vez verían cada uno «hay otro Dueño» y el espacio se quedaría sin ninguno.
   */
  private async changeMembership(tenantId: string, targetId: string, decide: (current: Role, owners: number) => { role: Role } | null): Promise<void> {
    if (!UUID.test(targetId)) throw new NotFoundException("Esa persona no es miembro de este espacio.");
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ userId: string }[]>(Prisma.sql`SELECT "userId" FROM "Membership" WHERE "tenantId" = ${tenantId}::uuid AND role = 'OWNER' ORDER BY "userId" FOR UPDATE`);
      const target = await tx.membership.findUnique({ where: { userId_tenantId: { userId: targetId, tenantId } }, select: { role: true } });
      if (!target) throw new NotFoundException("Esa persona no es miembro de este espacio.");
      const change = decide(target.role, locked.length);
      if (change === null) await tx.membership.delete({ where: { userId_tenantId: { userId: targetId, tenantId } } });
      else await tx.membership.update({ where: { userId_tenantId: { userId: targetId, tenantId } }, data: { role: change.role } });
    });
  }

  // ── espacios de una persona ───────────────────────────────────────────────────────────────────

  async listWorkspaces(userId: string, activeTenantId: string): Promise<{ workspaces: { id: string; name: string; role: Role; active: boolean }[] }> {
    const rows = await this.prisma.membership.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { role: true, tenant: { select: { id: true, name: true } } } });
    return { workspaces: rows.map((row) => ({ id: row.tenant.id, name: row.tenant.name, role: row.role, active: row.tenant.id === activeTenantId })) };
  }

  /** Cambia el espacio activo de ESTA sesión. Solo a un espacio donde la persona es miembro; si no, 404 (no se revela cuáles existen). */
  async switchWorkspace(sessionId: string, userId: string, body: unknown): Promise<{ tenant: { id: string; name: string }; role: Role }> {
    const tenantId = (body as { tenantId?: unknown } | null)?.tenantId;
    if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new BadRequestException("tenantId debe ser el identificador de un espacio de trabajo.");
    const membership = await this.prisma.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } }, select: { role: true, tenant: { select: { id: true, name: true } } } });
    if (!membership) throw new NotFoundException("No eres miembro de ese espacio de trabajo.");
    await this.prisma.session.updateMany({ where: { id: sessionId, userId }, data: { tenantId } });
    return { tenant: membership.tenant, role: membership.role };
  }
}

function parseRole(body: unknown): Role {
  const role = (body as { role?: unknown } | null)?.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) throw new BadRequestException("role debe ser OWNER, EDITOR o VIEWER.");
  return role as Role;
}

const lastOwner = (): ConflictException => new ConflictException("Este espacio no puede quedarse sin Dueño: promueve a otra persona a Dueño primero.");

function toInviteView(row: { id: string; role: Role; createdAt: Date; expiresAt: Date }): InviteView {
  return { id: row.id, role: row.role, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
}
