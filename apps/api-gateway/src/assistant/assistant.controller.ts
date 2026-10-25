import { Body, Controller, HttpCode, Post } from "@nestjs/common";

import { JobIdPipe } from "../jobs/job-id.pipe.js";
import { TenantId } from "../tenancy/tenant-auth.guard.js";
import { AssistantService } from "./assistant.service.js";

/** Chat del asistente de la interfaz (ADR 0028). POST: pide Editor por el método HTTP. Solo modo local (404 si no). */
@Controller("v1/assistant")
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post("chat")
  @HttpCode(200)
  chat(@TenantId() tenantId: string, @Body() body: unknown): Promise<{ reply: string }> {
    const { messages, jobId, ai } = (typeof body === "object" && body !== null ? body : {}) as { messages?: unknown; jobId?: unknown; ai?: unknown };
    return this.assistant.chat(tenantId, { messages, ai, jobId: typeof jobId === "string" ? new JobIdPipe().transform(jobId) : undefined });
  }
}
