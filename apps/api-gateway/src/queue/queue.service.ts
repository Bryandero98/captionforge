import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import type { BurnJob, TranscribeJob } from "@captionforge/contracts/types";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { assertContract } from "../contracts/validators.js";
import type { JobKind } from "../generated/prisma/client.js";
import { CANCEL_CHANNEL, QUEUES } from "./names.js";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly transcribe: Queue;
  private readonly burn: Queue;
  private readonly publisher: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const connection = { host: config.redis.host, port: config.redis.port, password: config.redis.password };
    // attempts: 1 (ADR 0006): un fallo se informa con un código del contrato, no se repite en silencio.
    const defaultJobOptions = { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } };
    this.transcribe = new Queue(QUEUES.transcribe, { connection, defaultJobOptions });
    this.burn = new Queue(QUEUES.burn, { connection, defaultJobOptions });
    this.publisher = new Redis(connection);
  }

  /** El jobId del contrato es el id de BullMQ: encolar dos veces el mismo trabajo no lo duplica. */
  async enqueueTranscribe(payload: TranscribeJob): Promise<void> {
    assertContract("transcribe-job.v1", payload);
    await this.transcribe.add("transcribe", payload, { jobId: payload.jobId });
  }

  async enqueueBurn(payload: BurnJob): Promise<void> {
    assertContract("burn-job.v1", payload);
    await this.burn.add("burn", payload, { jobId: payload.jobId });
  }

  /** Quita el trabajo de la cola si todavía no empezó. true = se quitó (nadie lo había tomado). */
  async removeIfWaiting(kind: JobKind, jobId: string): Promise<boolean> {
    const job = await (kind === "BURN" ? this.burn : this.transcribe).getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state !== "waiting" && state !== "delayed" && state !== "prioritized") return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false; // otro worker lo tomó entre el estado y el borrado
    }
  }

  /** Pide al worker que aborte el trabajo en curso (cancelación cooperativa, ADR 0006). */
  async requestCancel(jobId: string): Promise<void> {
    const message = { schemaVersion: 1, jobId };
    assertContract("cancel-message.v1", message);
    await this.publisher.publish(CANCEL_CHANNEL, JSON.stringify(message));
  }

  async ping(): Promise<void> {
    await this.publisher.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.transcribe.close(), this.burn.close()]);
    this.publisher.disconnect();
  }
}
