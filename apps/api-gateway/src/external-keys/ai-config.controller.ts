import { Controller, Get } from "@nestjs/common";

import { TenantId } from "../tenancy/tenant-auth.guard.js";
import { type AiConfigView, ExternalKeysService } from "./external-keys.service.js";

/**
 * Configuración de IA del espacio que cualquier miembro puede ver (ADR 0022): el host y el modelo con los que se traducirá, para que
 * la confirmación de gasto diga a dónde va el texto. Nunca la URL completa ni la clave. Con la función apagada responde 404.
 */
@Controller("v1/workspaces/current/ai-config")
export class AiConfigController {
  constructor(private readonly keys: ExternalKeysService) {}

  @Get()
  get(@TenantId() tenantId: string): Promise<AiConfigView> {
    return this.keys.aiConfig(tenantId);
  }
}
