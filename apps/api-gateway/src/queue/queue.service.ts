import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import type { BurnJob, DubJob, TranscribeJob, TranslateJob } from "@captionforge/contracts/types";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { assertContract } from "../contracts/validators.js";
import type { JobKind } from "../generated/prisma/client.js";
import { CANCEL_CHANNEL, QUEUES } from "./names.js";

/** Tope de espera de un comando Redis de la cola (encolar, existe, publicar, ping). */
export const REDIS_COMMAND_TIMEOUT_MS = 4000;

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly transcribe: Queue;
  private readonly burn: Queue;
  private readonly translate: Queue;
  private readonly dub: Queue;
  private readonly publisher: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // Redis caído o colgado no debe dejar peticiones esperando minutos: sin cola offline los comandos fallan al instante mientras no
    // hay conexión, y uno que no recibe respuesta se rinde a los pocos segundos. El llamador lo traduce a 503 (failEnqueue).
    // Con los valores por defecto de BullMQ/ioredis (cola offline y 20 reintentos) una subida quedaba colgada ~4 min y /health ~10 s.
    const connection = {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      enableOfflineQueue: false,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    };
    // attempts: 1 (ADR 0006): un fallo se informa con un código del contrato, no se repite en silencio.
    const defaultJobOptions = { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } };
    this.transcribe = new Queue(QUEUES.transcribe, { connection, defaultJobOptions });
    this.burn = new Queue(QUEUES.burn, { connection, defaultJobOptions });
    this.translate = new Queue(QUEUES.translate, { connection, defaultJobOptions });
    this.dub = new Queue(QUEUES.dub, { connection, defaultJobOptions });
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

  async enqueueTranslate(payload: TranslateJob): Promise<void> {
    assertContract("translate-job.v1", payload);
    await this.translate.add("translate", payload, { jobId: payload.jobId });
  }

  async enqueueDub(payload: DubJob): Promise<void> {
    assertContract("dub-job.v1", payload);
    await this.dub.add("dub", payload, { jobId: payload.jobId });
  }

  private queueFor(kind: JobKind): Queue {
    switch (kind) {
      case "BURN":
        return this.burn;
      case "TRANSLATE":
        return this.translate;
      case "DUB":
        return this.dub;
      default:
        return this.transcribe;
    }
  }

  /** ¿Sigue el trabajo en su cola, en cualquier estado? (esperando, activo, completado o fallido) */
  async exists(kind: JobKind, jobId: string): Promise<boolean> {
    const job = await this.queueFor(kind).getJob(jobId);
    if (!job) return false;
    // Un trabajo fallido o completado en Redis ya no va a ejecutarse: para una fila QUEUED es como si se hubiera perdido
    // (p. ej. el worker no pudo reclamarlo porque PostgreSQL estaba caído y BullMQ lo dio por fallido).
    const state = await job.getState();
    return state !== "failed" && state !== "completed";
  }

  /** Quita el trabajo de la cola si todavía no empezó. true = se quitó (nadie lo había tomado). */
  async removeIfWaiting(kind: JobKind, jobId: string): Promise<boolean> {
    const job = await this.queueFor(kind).getJob(jobId);
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
  /** Devuelve cuántos workers recibieron el aviso (0 = nadie escucha). */
  async requestCancel(jobId: string): Promise<number> {
    const message = { schemaVersion: 1, jobId };
    assertContract("cancel-message.v1", message);
    await this.publisherReady();
    return this.publisher.publish(CANCEL_CHANNEL, JSON.stringify(message));
  }

  async ping(): Promise<void> {
    await this.publisherReady();
    await this.publisher.ping();
  }

  /**
   * Sin cola offline, un comando emitido ANTES de la primera conexión (arranque, o un /health en los primeros milisegundos) fallaría
   * aunque Redis esté sano: ahí se espera, con tope. Si la conexión ya existió y se cayó (reconectando) no se espera: falla al instante,
   * que es justo lo que se quiere.
   */
  private async publisherReady(): Promise<void> {
    const status = this.publisher.status;
    if (status !== "wait" && status !== "connecting" && status !== "connect") return;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error): void => {
        clearTimeout(timer);
        this.publisher.off("ready", onReady);
        if (error) reject(error);
        else resolve();
      };
      const onReady = (): void => done();
      const timer = setTimeout(() => done(new Error("Redis no terminó de conectar a tiempo")), REDIS_COMMAND_TIMEOUT_MS);
      this.publisher.once("ready", onReady);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.transcribe.close(), this.burn.close(), this.translate.close(), this.dub.close()]);
    this.publisher.disconnect();
  }
}
