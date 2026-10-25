import { Controller, Get, Inject } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { EXTERNAL_PROVIDERS, type ExternalProvider } from "../external-keys/external-key-crypto.js";
import { BURN_TEMPLATES } from "../jobs/burn-options.js";

export interface Capabilities {
  diarization: { enabled: boolean };
  /** Claves externas propias (ADR 0020): solo si el servidor tiene APP_SECRET. `providers` vacío cuando está apagada. */
  byok: { enabled: boolean; providers: readonly ExternalProvider[]; allowPrivateBaseUrls: boolean };
  /** Límites que el servidor aplica: la interfaz avisa ANTES de subir en vez de descubrir un 413 al final. */
  limits: { verticalMaxSeconds: number };
  /** Plantillas de subtítulos dinámicos que acepta el quemado. */
  burn: { templates: readonly string[] };
  /** Asistente de la interfaz (ADR 0028): solo en modo local (la IA propia de la persona viaja en cada mensaje, no se guarda). */
  assistant: { enabled: boolean };
}

@Controller("v1/capabilities")
export class CapabilitiesController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Qué funciones opcionales y qué límites tiene este servidor. Solo booleanos, números y nombres públicos: nunca tokens ni rutas. */
  @Get()
  get(): Capabilities {
    const byok = this.config.byok.appSecret !== undefined;
    return {
      diarization: { enabled: this.config.features.diarization },
      byok: { enabled: byok, providers: byok ? EXTERNAL_PROVIDERS : [], allowPrivateBaseUrls: byok && this.config.byok.allowPrivateBaseUrls },
      limits: { verticalMaxSeconds: this.config.burn.verticalMaxSeconds },
      burn: { templates: BURN_TEMPLATES },
      assistant: { enabled: this.config.auth.localMode },
    };
  }
}
