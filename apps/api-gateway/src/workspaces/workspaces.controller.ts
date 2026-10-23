import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";

import { MinRole } from "../tenancy/roles.js";
import { SessionUserId, TenantId } from "../tenancy/tenant-auth.guard.js";
import { WorkspacesService } from "./workspaces.service.js";

/**
 * Equipos (ADR 0019). Gestionar miembros e invitaciones es del Dueño; ver los propios espacios y aceptar una invitación lo puede
 * hacer cualquier miembro (quien acepta quizá es solo Lector en su espacio activo, por eso `VIEWER` explícito: sin él, un POST
 * pediría Editor). Todo lo que identifica a una PERSONA (no a un tenant) rechaza las claves de API.
 */
@Controller("v1/workspaces")
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@TenantId() tenantId: string, @SessionUserId() userId: string) {
    return this.workspaces.listWorkspaces(userId, tenantId);
  }

  @Get("members")
  @MinRole("OWNER")
  members(@TenantId() tenantId: string) {
    return this.workspaces.listMembers(tenantId);
  }

  @Put("members/:userId")
  @MinRole("OWNER")
  setRole(@TenantId() tenantId: string, @Param("userId") userId: string, @Body() body: unknown) {
    return this.workspaces.setMemberRole(tenantId, userId, body);
  }

  @Delete("members/:userId")
  @HttpCode(204)
  @MinRole("OWNER")
  async remove(@TenantId() tenantId: string, @Param("userId") userId: string): Promise<void> {
    await this.workspaces.removeMember(tenantId, userId);
  }

  @Get("invites")
  @MinRole("OWNER")
  invites(@TenantId() tenantId: string) {
    return this.workspaces.listInvites(tenantId);
  }

  @Post("invites")
  @HttpCode(201)
  @MinRole("OWNER")
  createInvite(@TenantId() tenantId: string, @SessionUserId() userId: string, @Body() body: unknown) {
    return this.workspaces.createInvite(tenantId, userId, body);
  }

  @Delete("invites/:id")
  @HttpCode(204)
  @MinRole("OWNER")
  async revokeInvite(@TenantId() tenantId: string, @Param("id") id: string): Promise<void> {
    await this.workspaces.revokeInvite(tenantId, id);
  }

  /** Sin sesión el guardián responde 401 (la interfaz manda a iniciar sesión); con clave de API, 403. */
  @Post("invites/:token/accept")
  @HttpCode(200)
  @MinRole("VIEWER")
  accept(@SessionUserId() userId: string, @Param("token") token: string) {
    return this.workspaces.acceptInvite(userId, token);
  }
}
