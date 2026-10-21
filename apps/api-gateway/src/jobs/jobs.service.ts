import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { TranscribeJob } from "@captionforge/contracts/types";
import { ContractViolation, assertContract } from "../contracts/validators.js";
import { Prisma, type Job, type JobStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { QueueService } from "../queue/queue.service.js";
import { StorageService } from "../storage/storage.service.js";

export const ALLOWED_CONTENT_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
] as const;

const TERMINAL: readonly JobStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export const isTerminal = (status: JobStatus): boolean => TERMINAL.includes(status);

export interface TranscriptionUpload {
  stream: Readable;
  filename: string;
  mimetype: string;
  options: unknown;
}

/** Lo que el API devuelve de un trabajo (sin bucket ni claves internas del almacenamiento). */
export interface JobView {
  id: string;
  kind: Job["kind"];
  status: JobStatus;
  stage: string | null;
  percent: number;
  message: string | null;
  originalFilename: string;
  sizeBytes: number;
  options: unknown;
  error: { code: string; message: string | null } | null;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function toView(job: Job): JobView {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    originalFilename: job.originalFilename,
    sizeBytes: Number(job.sizeBytes), // el máximo del contrato (100 GiB) cabe en un número seguro
    options: job.options,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** El nombre del usuario es solo informativo: se queda con el último segmento y lo acota. */
function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) throw new BadRequestException("El archivo no tiene nombre.");
  return base.slice(0, 255);
}

const ARTIFACT_SUFFIX: Record<string, string> = { srt: ".srt", segments: ".segments.json", waveform: ".waveform.json" };

/** Nombre de descarga: el del video original con la extensión del artefacto (sin su extensión de video). */
export function downloadName(originalFilename: string, artifact: string): string {
  const stem = originalFilename.replace(/\.[A-Za-z0-9]{1,10}$/, "") || "captionforge";
  return `${stem}${ARTIFACT_SUFFIX[artifact] ?? ""}`;
}

/** Content-Disposition seguro: sin comillas ni saltos de línea y con el nombre real en UTF-8 (RFC 6266). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return match?.[1] ? `.${match[1].toLowerCase()}` : "";
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  async createTranscription(upload: TranscriptionUpload): Promise<JobView> {
    if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(upload.mimetype)) {
      throw new UnsupportedMediaTypeException(`Tipo de archivo no admitido: ${upload.mimetype}`);
    }
    const options = this.parseOptions(upload.options);
    const originalFilename = cleanFilename(upload.filename);

    const id = randomUUID();
    const inputKey = `jobs/${id}/input${extensionOf(originalFilename)}`;
    const outputPrefix = `jobs/${id}/out/`;

    const { sizeBytes } = await this.storage.putStream(inputKey, upload.stream, upload.mimetype);
    if (sizeBytes === 0) {
      await this.storage.delete(inputKey).catch(() => undefined);
      throw new BadRequestException("El archivo está vacío.");
    }

    const payload: TranscribeJob = {
      schemaVersion: 1,
      jobId: id,
      requestedAt: new Date().toISOString(),
      input: {
        bucket: this.storage.bucket,
        objectKey: inputKey,
        originalFilename,
        contentType: upload.mimetype as TranscribeJob["input"]["contentType"],
        sizeBytes,
      },
      outputPrefix,
      options,
    };
    try {
      assertContract("transcribe-job.v1", payload);
    } catch (error) {
      await this.storage.delete(inputKey).catch(() => undefined);
      if (error instanceof ContractViolation) throw new BadRequestException(error.message);
      throw error;
    }

    let job: Job;
    try {
      job = await this.prisma.job.create({
        data: {
          id,
          kind: "TRANSCRIBE",
          inputBucket: payload.input.bucket,
          inputKey,
          originalFilename,
          contentType: upload.mimetype,
          sizeBytes: BigInt(sizeBytes),
          outputPrefix,
          options: options as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      await this.storage.delete(inputKey).catch(() => undefined);
      throw error;
    }

    try {
      await this.queue.enqueueTranscribe(payload);
    } catch (error) {
      this.logger.error(`No se pudo encolar el trabajo ${id}: ${(error as Error).message}`);
      // Compensación, cada paso por separado: que falle uno (p. ej. la base de datos también está
      // caída) no debe impedir los demás ni cambiar la respuesta, que siempre es 503.
      await this.prisma.job
        .updateMany({
          where: { id, status: "QUEUED" },
          data: {
            status: "FAILED",
            errorCode: "INTERNAL",
            errorMessage: "No se pudo encolar el trabajo.",
            finishedAt: new Date(),
          },
        })
        .catch((e: unknown) => this.logger.error(`No se pudo marcar fallido el trabajo ${id}: ${(e as Error).message}`));
      await this.storage.delete(inputKey).catch(() => undefined);
      throw new ServiceUnavailableException("La cola no está disponible. Inténtalo de nuevo en un momento.");
    }
    return toView(job);
  }

  async get(id: string): Promise<JobView> {
    return toView(await this.require(id));
  }

  /** Para el stream de eventos: undefined = no existe. */
  async find(id: string): Promise<Job | null> {
    return this.prisma.job.findUnique({ where: { id } });
  }

  async cancel(id: string): Promise<JobView> {
    const job = await this.require(id);
    if (isTerminal(job.status)) {
      throw new ConflictException(`El trabajo ya terminó (${job.status}).`);
    }
    // La transición QUEUED -> CANCELLED es la que decide la carrera con el worker: su `claim` es la
    // misma comparación (UPDATE ... WHERE status = 'QUEUED'), así que solo uno de los dos gana. Antes
    // se quitaba el trabajo de la cola y luego se actualizaba la fila: si el worker lo tomaba entre
    // ambos pasos, la fila quedaba CANCELLED mientras el video se procesaba entero.
    const cancelled = await this.prisma.job.updateMany({
      where: { id, status: "QUEUED" },
      data: { status: "CANCELLED", errorCode: "CANCELLED", errorMessage: "Cancelado por el usuario.", finishedAt: new Date() },
    });
    if (cancelled.count === 1) {
      // Ganó el API: el worker, si llega a recibirlo, ve que ya no está QUEUED y lo omite. Quitarlo
      // de la cola es solo limpieza, por eso un fallo aquí no se propaga.
      await this.queue.removeIfWaiting(id).catch((e: unknown) =>
        this.logger.warn(`No se pudo quitar ${id} de la cola: ${(e as Error).message}`),
      );
      return toView(await this.require(id));
    }
    // Perdió: el worker ya lo tomó (o terminó entre la lectura y aquí). Se relee y se avisa al worker.
    const current = await this.require(id);
    if (isTerminal(current.status)) {
      throw new ConflictException(`El trabajo ya terminó (${current.status}).`);
    }
    await this.queue.requestCancel(id);
    return toView(current);
  }

  /**
   * Devuelve la clave de un artefacto del resultado, o null si el trabajo aún no lo tiene.
   * El resultado lo escribe el worker; aun así solo se sirven claves bajo el prefijo de salida de
   * este trabajo, para que un resultado corrupto no pueda exponer objetos de otro trabajo.
   */
  async artifactKey(id: string, name: string): Promise<{ key: string; filename: string } | null> {
    const job = await this.require(id);
    if (job.status !== "COMPLETED") return null;
    const artifacts = (job.result as { artifacts?: Record<string, unknown> } | null)?.artifacts;
    const entry = artifacts?.[name];
    const key = typeof entry === "string" ? entry : (entry as { objectKey?: unknown } | undefined)?.objectKey;
    if (typeof key !== "string" || !key.startsWith(job.outputPrefix) || key.includes("..")) return null;
    return { key, filename: downloadName(job.originalFilename, name) };
  }

  private async require(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException("No existe ese trabajo.");
    return job;
  }

  private parseOptions(raw: unknown): TranscribeJob["options"] {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BadRequestException('El campo "options" debe ser un objeto JSON.');
    }
    const given = raw as Record<string, unknown>;
    // Los valores por defecto se aplican aquí; claves desconocidas las rechaza el contrato.
    return { modelSize: "small", sourceLanguage: null, translateTo: null, ...given } as TranscribeJob["options"];
  }
}
