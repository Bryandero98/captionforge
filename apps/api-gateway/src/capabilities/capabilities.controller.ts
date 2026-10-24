import { Controller, Get, Inject } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { EXTERNAL_PROVIDERS, type ExternalProvider } from "../external-keys/external-key-crypto.js";

export interface Capabilities {
  diarization: { enabled: boolean };
  /** Claves externas propias (ADR 0020): solo si el servidor tiene APP_SECRET. `providers` vacío cuando está apagada. */
  byok: { enabled: boolean; providers: readonly ExternalProvider[]; allowPrivateBaseUrls: boolean };
}

@Controller("v1/capabilities")
export class CapabilitiesController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Qué funciones opcionales ofrece este servidor. Solo booleanos: nunca tokens ni rutas. */
  @Get()
  get(): Capabilities {
    const byok = this.config.byok.appSecret !== undefined;
    return { diarization: { enabled: this.config.features.diarization }, byok: { enabled: byok, providers: byok ? EXTERNAL_PROVIDERS : [], allowPrivateBaseUrls: byok && this.config.byok.allowPrivateBaseUrls } };
  }
}
