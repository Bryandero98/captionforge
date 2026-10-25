import { BadGatewayException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { JobsService } from "../jobs/jobs.service.js";
import { buildChatRequest, type JobContext, parseAiCredentials, parseChatResponse, type ProposedAction, sanitizeMessages } from "./chat.js";
import { type ChatTransport, createPinnedTransport } from "./pinned-https.js";

export const CHAT_TRANSPORT = Symbol("CHAT_TRANSPORT");

/**
 * Asistente de la interfaz (v1.3.1, ADR 0028). Solo en modo local. Usa la IA de la persona (clave, URL base y modelo) que el navegador manda en cada
 * mensaje: no se guarda ni se registra, solo viaja en la cabecera hacia un host validado y con la IP fijada. El servidor no ejecuta nada: devuelve texto y acciones PROPUESTAS (saneadas) que la página aplica solo si la persona confirma.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly transport: ChatTransport;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jobs: JobsService,
    @Optional() @Inject(CHAT_TRANSPORT) transport?: ChatTransport,
  ) {
    this.transport = transport ?? createPinnedTransport(config.byok.allowPrivateBaseUrls);
  }

  async chat(tenantId: string, input: { messages: unknown; jobId?: string; ai?: unknown }): Promise<{ reply: string; actions: ProposedAction[] }> {
    if (!this.config.auth.localMode) throw new NotFoundException("No encontrado.");
    const messages = sanitizeMessages(input.messages);

    const credential = parseAiCredentials(input.ai, this.config.byok.allowPrivateBaseUrls);

    let job: JobContext | null = null;
    if (input.jobId !== undefined) {
      const view = await this.jobs.get(tenantId, input.jobId);
      job = { status: view.status, mediaKind: view.mediaKind };
    }

    try {
      const payload = await this.transport(buildChatRequest({ key: credential.key, baseUrl: credential.baseUrl, model: credential.model, messages, job }));
      return parseChatResponse(payload);
    } catch (error) {
      // Nunca se repite el mensaje original: podría llevar texto del proveedor. Solo qué falló, en general.
      this.logger.warn(`El asistente no obtuvo respuesta de la IA (${(error as Error).name}).`);
      throw new BadGatewayException({ statusCode: 502, error: "Bad Gateway", code: "ai_unavailable", message: "La IA no respondió. Revisa tu clave, el modelo y tu saldo, e inténtalo de nuevo." });
    }
  }
}
