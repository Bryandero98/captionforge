import { Controller, Get, Inject } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";

export interface Capabilities {
  diarization: { enabled: boolean };
}

@Controller("v1/capabilities")
export class CapabilitiesController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Qué funciones opcionales ofrece este servidor. Solo booleanos: nunca tokens ni rutas. */
  @Get()
  get(): Capabilities {
    return { diarization: { enabled: this.config.features.diarization } };
  }
}
