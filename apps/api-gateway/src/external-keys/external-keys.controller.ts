import { Body, Controller, Delete, Get, HttpCode, Param, Put } from "@nestjs/common";

import { MinRole } from "../tenancy/roles.js";
import { SessionUserId, TenantId } from "../tenancy/tenant-auth.guard.js";
import { ExternalKeysService, type ExternalKeyView } from "./external-keys.service.js";

/**
 * Claves de proveedores externos del espacio activo (ADR 0020). Solo el Dueño y solo con sesión: `@SessionUserId` rechaza las claves de
 * API (que actúan como Editor y, además, no son de nadie). El Editor USA las claves al lanzar trabajos, pero no las gestiona.
 * Las respuestas llevan `Cache-Control: no-store` por el gancho global de main.ts (lo exige external-keys.e2e.spec.ts).
 */
@Controller("v1/workspaces/current/external-keys")
export class ExternalKeysController {
  constructor(private readonly keys: ExternalKeysService) {}

  @Get()
  @MinRole("OWNER")
  list(@TenantId() tenantId: string, @SessionUserId() _userId: string): Promise<{ keys: ExternalKeyView[] }> {
    return this.keys.list(tenantId);
  }

  @Put(":provider")
  @MinRole("OWNER")
  put(@TenantId() tenantId: string, @SessionUserId() userId: string, @Param("provider") provider: string, @Body() body: unknown): Promise<ExternalKeyView> {
    return this.keys.put(tenantId, userId, provider, body);
  }

  @Delete(":provider")
  @HttpCode(204)
  @MinRole("OWNER")
  async remove(@TenantId() tenantId: string, @SessionUserId() _userId: string, @Param("provider") provider: string): Promise<void> {
    await this.keys.remove(tenantId, provider);
  }
}
