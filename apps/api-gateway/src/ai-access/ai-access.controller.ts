import { Controller, Get, Header, Inject, NotFoundException } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { buildLlmsTxt } from "./llms.js";
import { buildOpenApi } from "./openapi.js";

/**
 * Acceso para IAs (v1.3.1, ADR 0028): instrucciones legibles y descripción del API. SOLO en modo local: con `LOCAL_MODE=false` (servidor
 * expuesto a otras personas) responde 404, igual que si no existieran. No lleva datos de nadie ni secretos: es documentación.
 */
@Controller()
export class AiAccessController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get("llms.txt")
  @Header("Content-Type", "text/plain; charset=utf-8")
  llms(): string {
    this.requireLocal();
    return buildLlmsTxt(this.config.auth.publicUrl);
  }

  @Get("openapi.json")
  openapi(): ReturnType<typeof buildOpenApi> {
    this.requireLocal();
    return buildOpenApi(this.config.auth.publicUrl);
  }

  private requireLocal(): void {
    if (!this.config.auth.localMode) throw new NotFoundException("No encontrado.");
  }
}
