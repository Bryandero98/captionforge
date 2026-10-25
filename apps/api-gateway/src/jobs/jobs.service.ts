import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { BurnJob, DubJob, TranscribeJob, TranslateJob } from "@captionforge/contracts/types";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ContractViolation, assertContract } from "../contracts/validators.js";
import { ExternalKeysService } from "../external-keys/external-keys.service.js";
import { Prisma, type Job, type JobStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { QueueService } from "../queue/queue.service.js";
import { StorageService } from "../storage/storage.service.js";
import { BURN_CANVASES, BURN_OPTION_KEYS, BURN_STYLES, BURN_TEMPLATES } from "./burn-options.js";
import { KeyedMutex } from "./keyed-mutex.js";
import { ALLOWED_CONTENT_TYPES, type MediaKind, mediaKindOf } from "./media-kind.js";
import { type Segment, SegmentsError, applyEdits, parseEdits, parseSegments, segmentsToSrt } from "./segments.js";


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
  /** Solo en los trabajos de quemado: la transcripción de la que parten. */
  parentJobId: string | null;
  status: JobStatus;
  stage: string | null;
  percent: number;
  message: string | null;
  originalFilename: string;
  /** Clase del archivo de entrada: la interfaz decide por ella el reproductor y qué acciones ofrece (sin quemado ni mezcla con audio). */
  mediaKind: MediaKind;
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
    parentJobId: job.parentJobId,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    originalFilename: job.originalFilename,
    mediaKind: mediaKindOf(job.contentType),
    sizeBytes: Number(job.sizeBytes), // el máximo del contrato (100 GiB) cabe en un número seguro
    options: job.options,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    result: publicResult(job.result),
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * El resultado del worker, sin bucket, claves ni ETag internos (ADR 0002): los artefactos se piden por
 * nombre en /artifacts/:name y los subtítulos, con su etag, en /segments.
 */
export function publicResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result ?? null;
  const { artifacts, ...rest } = result as { artifacts?: Record<string, unknown> } & Record<string, unknown>;
  return { ...rest, artifacts: artifacts ? Object.keys(artifacts) : [] };
}

/** El nombre del usuario es solo informativo: se queda con el último segmento y lo acota. */
function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) throw new BadRequestException("El archivo no tiene nombre.");
  return base.slice(0, 255);
}

const ARTIFACT_SUFFIX: Record<string, string> = {
  srt: ".srt",
  segments: ".segments.json",
  waveform: ".waveform.json",
  video: ".captioned.mp4",
  audio: ".dub.mp3",
};

/** Artefactos que existen en el resultado de cada tipo de trabajo. */
const ARTIFACTS_BY_KIND: Record<Job["kind"], readonly string[]> = {
  TRANSCRIBE: ["srt", "segments", "waveform"],
  BURN: ["video"],
  // Traducir y doblar (ADR 0020): el doblaje entrega la pista de voz y, si se pidió mezcla, el video doblado.
  TRANSLATE: ["segments"],
  DUB: ["audio", "video"],
};

const MAX_SEGMENTS_BYTES = 32 * 1024 * 1024;

/** Error con `code` estable: la interfaz decide el texto por el código, no por el mensaje. */
const coded = (Exception: new (response: object) => Error, status: number, error: string, code: string, message: string): Error =>
  new Exception({ statusCode: status, error, code, message });

/** Nombre de descarga: el del video original con la extensión del artefacto (sin su extensión de video). */
export function downloadName(originalFilename: string, artifact: string, kind?: Job["kind"]): string {
  const stem = originalFilename.replace(/\.[A-Za-z0-9]{1,10}$/, "") || "captionforge";
  // El video del doblaje no es el de los subtítulos quemados: ambos se llaman `video` en su resultado.
  const suffix = kind === "DUB" && artifact === "video" ? ".dubbed.mp4" : (ARTIFACT_SUFFIX[artifact] ?? "");
  return `${stem}${suffix}`;
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

/** Máximo de trabajos por página en GET /v1/jobs (protección contra consultas sin tope). */
export const MAX_LIST_LIMIT = 100;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  /** Serializa las ediciones de subtítulos de un mismo trabajo (ver KeyedMutex). */
  private readonly segmentEdits = new KeyedMutex();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly externalKeys: ExternalKeysService,
  ) {}

  /**
   * Aislamiento por tenant (ADR 0015): TODA operación recibe el `tenantId` de la clave de API y lo usa en la consulta
   * (`where: { id, tenantId }`), nunca después de leer. Un trabajo de otro tenant es indistinguible de uno que no
   * existe: 404, no 403, para no revelar que el UUID es real.
   */
  async createTranscription(tenantId: string, upload: TranscriptionUpload): Promise<JobView> {
    if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(upload.mimetype)) {
      throw new UnsupportedMediaTypeException(`Tipo de archivo no admitido: ${upload.mimetype}`);
    }
    const options = this.parseOptions(upload.options);
    const originalFilename = cleanFilename(upload.filename);

    const id = randomUUID();
    const inputKey = `jobs/${id}/input${extensionOf(originalFilename)}`;
    const outputPrefix = `jobs/${id}/out/`;

    // Se valida contra el contrato ANTES de subir: unas opciones inválidas con un video de 4 GiB
    // gastaban todo el ancho de banda y el almacenamiento para responder 400 al final.
    try {
      assertContract("transcribe-job.v1", {
        schemaVersion: 1,
        jobId: id,
        requestedAt: new Date().toISOString(),
        input: { bucket: this.storage.bucket, objectKey: inputKey, originalFilename, contentType: upload.mimetype, sizeBytes: 1 },
        outputPrefix,
        options,
      });
    } catch (error) {
      if (error instanceof ContractViolation) throw new BadRequestException(error.message);
      throw error;
    }

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
          tenantId,
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
      await this.failEnqueue(id, error, [inputKey]);
    }
    return toView(job);
  }

  /**
   * Crea un trabajo derivado (quemar, traducir, doblar). El `count()` previo es solo la respuesta rápida; quien garantiza que no haya dos
   * activos de la misma clase por transcripción es el índice único parcial `Job_one_active_derived_per_parent`: si dos peticiones pasan
   * el conteo a la vez, la segunda choca con él (P2002) y recibe el mismo 409.
   */
  private async createDerived(args: Prisma.JobCreateArgs, busyMessage: string): Promise<Job> {
    try {
      return await this.prisma.job.create(args);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException(busyMessage);
      throw error;
    }
  }

  /** Compensación al fallar el encolado, paso a paso: que falle uno (p. ej. la base también está caída)
   *  no impide los demás ni cambia la respuesta, que siempre es 503. */
  private async failEnqueue(id: string, error: unknown, objectsToDelete: string[]): Promise<never> {
    this.logger.error(`No se pudo encolar el trabajo ${id}: ${(error as Error).message}`);
    const closed = await this.prisma.job
      .updateMany({
        where: { id, status: "QUEUED" },
        data: { status: "FAILED", errorCode: "INTERNAL", errorMessage: "No se pudo encolar el trabajo.", finishedAt: new Date() },
      })
      .then((r) => r.count)
      .catch((e: unknown) => {
        this.logger.error(`No se pudo marcar fallido el trabajo ${id}: ${(e as Error).message}`);
        return 0;
      });
    // Si el fallo fue ambiguo (el comando llegó a Redis) y un worker ya tomó el trabajo, la fila no está QUEUED:
    // borrar su entrada lo haría fallar a mitad de camino.
    if (closed === 1) for (const key of objectsToDelete) await this.storage.delete(key).catch(() => undefined);
    throw new ServiceUnavailableException("La cola no está disponible. Inténtalo de nuevo en un momento.");
  }

  /** La transcripción terminada de la que cuelgan los subtítulos; 409 si todavía no hay nada que editar o quemar. */
  private async completedTranscription(tenantId: string, id: string): Promise<{ job: Job; segmentsKey: string }> {
    const job = await this.require(tenantId, id);
    if (job.kind !== "TRANSCRIBE") throw new ConflictException("Solo las transcripciones tienen subtítulos.");
    if (job.status !== "COMPLETED") throw new ConflictException("La transcripción todavía no terminó.");
    const key = (job.result as { artifacts?: { segments?: { objectKey?: unknown } } } | null)?.artifacts?.segments?.objectKey;
    if (typeof key !== "string" || !key.startsWith(job.outputPrefix) || key.includes("..")) {
      throw new ConflictException("La transcripción no tiene subtítulos disponibles.");
    }
    return { job, segmentsKey: key };
  }

  private async readSegments(key: string): Promise<{ segments: Segment[]; etag: string }> {
    const stored = await this.storage.getBuffer(key, MAX_SEGMENTS_BYTES).catch((error: unknown) => {
      if (error instanceof PayloadTooLargeException) throw new ConflictException("Los subtítulos guardados son demasiado grandes para editarlos.");
      throw error;
    });
    if (!stored) throw new ConflictException("Los subtítulos ya no están disponibles (caducaron).");
    try {
      return { segments: parseSegments(JSON.parse(stored.body.toString("utf-8"))), etag: stored.etag };
    } catch (error) {
      this.logger.error(`segments.json ilegible (${key}): ${(error as Error).message}`);
      throw new ConflictException("Los subtítulos guardados no se pueden leer.");
    }
  }

  async getSegments(tenantId: string, id: string): Promise<{ segments: (Segment & { index: number })[]; etag: string }> {
    const { segmentsKey } = await this.completedTranscription(tenantId, id);
    const { segments, etag } = await this.readSegments(segmentsKey);
    return { segments: segments.map((segment, index) => ({ index, ...segment })), etag };
  }

  /**
   * Aplica ediciones parciales (texto y/o tiempos por índice) y reescribe segments.json y output.srt.
   * Si el cuerpo trae `etag`, se rechaza con 409 cuando los subtítulos cambiaron desde que se leyeron.
   * Cambiar los subtítulos invalida los quemados que ya estén en cola (el worker lo detecta por el ETag).
   */
  async updateSegments(tenantId: string, id: string, body: unknown): Promise<{ segments: (Segment & { index: number })[]; etag: string }> {
    let parsed: ReturnType<typeof parseEdits>;
    try {
      parsed = parseEdits(body);
    } catch (error) {
      if (error instanceof SegmentsError) throw new BadRequestException(error.message);
      throw error;
    }
    // Leer el ETag, compararlo y escribir es una sola operación: dos PUT con el mismo ETag no pueden pasar los dos.
    return this.segmentEdits.run(id, () => this.applySegmentEdits(tenantId, id, parsed));
  }

  private async applySegmentEdits(tenantId: string, id: string, parsed: ReturnType<typeof parseEdits>): Promise<{ segments: (Segment & { index: number })[]; etag: string }> {
    const { job, segmentsKey } = await this.completedTranscription(tenantId, id);
    const current = await this.readSegments(segmentsKey);
    if (parsed.etag !== undefined && parsed.etag !== current.etag) {
      throw new ConflictException("Los subtítulos cambiaron desde que los leíste. Vuelve a cargarlos.");
    }
    let updated: Segment[];
    try {
      updated = applyEdits(current.segments, parsed.edits);
    } catch (error) {
      if (error instanceof SegmentsError) throw new BadRequestException(error.message);
      throw error;
    }

    const serialized = Buffer.from(JSON.stringify(updated));
    if (serialized.length > MAX_SEGMENTS_BYTES) throw new BadRequestException("Las ediciones hacen los subtítulos demasiado grandes.");
    const { etag } = await this.storage.putBuffer(segmentsKey, serialized, "application/json");
    const srtKey = (job.result as { artifacts?: { srt?: unknown } } | null)?.artifacts?.srt;
    if (typeof srtKey === "string" && srtKey.startsWith(job.outputPrefix) && !srtKey.includes("..")) {
      await this.storage.putBuffer(srtKey, Buffer.from(segmentsToSrt(updated)), "application/x-subrip");
    }
    // El ETag nuevo queda en el resultado: es el que se pasará al worker en el próximo quemado.
    const result = job.result as { artifacts: { segments: Record<string, unknown> } } & Record<string, unknown>;
    result.artifacts.segments = { ...result.artifacts.segments, etag };
    await this.prisma.job.updateMany({ where: { id, tenantId }, data: { result: result as unknown as Prisma.InputJsonValue } });
    return { segments: updated.map((segment, index) => ({ index, ...segment })), etag };
  }

  /** Pide el quemado de los subtítulos APROBADOS (los actuales) sobre el video original. */
  async createBurn(tenantId: string, parentId: string, rawOptions: unknown): Promise<JobView> {
    const options = this.parseBurnOptions(rawOptions);
    const { job: parent, segmentsKey } = await this.completedTranscription(tenantId, parentId);
    if (mediaKindOf(parent.contentType) === "audio") {
      throw coded(BadRequestException, 400, "Bad Request", "burn_not_available_for_audio", "Un audio no tiene imagen: no se pueden quemar subtítulos. Descarga el .srt.");
    }
    const duration = (parent.result as { durationSeconds?: unknown } | null)?.durationSeconds;
    // Tope de duración del video en 9:16: una sola variable (VERTICAL_MAX_SECONDS) que también lee el worker, que además recorta con `-t`.
    const verticalMax = this.config.burn.verticalMaxSeconds;
    if (options.canvas === "vertical" && typeof duration === "number" && duration > verticalMax) {
      throw coded(
        PayloadTooLargeException,
        413,
        "Payload Too Large",
        "job_too_large",
        `El video dura ${Math.ceil(duration)} s y el formato vertical 9:16 admite hasta ${verticalMax / 60} minutos. Quémalo con la forma original.`,
      );
    }
    const head = await this.storage.head(segmentsKey);
    if (!head) throw new ConflictException("Los subtítulos ya no están disponibles (caducaron).");

    const active = await this.prisma.job.count({
      where: { tenantId, kind: "BURN", parentJobId: parent.id, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (active > 0) throw new ConflictException("Ya hay un quemado en curso para esta transcripción. Espera a que termine o cancélalo.");

    const id = randomUUID();
    const outputPrefix = `jobs/${id}/out/`;
    const payload: BurnJob = {
      schemaVersion: 1,
      jobId: id,
      requestedAt: new Date().toISOString(),
      input: { bucket: parent.inputBucket, objectKey: parent.inputKey },
      segments: { bucket: this.storage.bucket, objectKey: segmentsKey, etag: head.etag },
      outputPrefix,
      options,
    };
    try {
      assertContract("burn-job.v1", payload);
    } catch (error) {
      if (error instanceof ContractViolation) throw new BadRequestException(error.message);
      throw error;
    }

    const job = await this.createDerived({
      data: {
        id,
        tenantId,
        kind: "BURN",
        parentJobId: parent.id,
        inputBucket: parent.inputBucket,
        inputKey: parent.inputKey,
        originalFilename: parent.originalFilename,
        contentType: parent.contentType,
        sizeBytes: parent.sizeBytes,
        outputPrefix,
        options: options as unknown as Prisma.InputJsonValue,
      },
    }, "Ya hay un quemado en curso para esta transcripción. Espera a que termine o cancélalo.");
    try {
      await this.queue.enqueueBurn(payload);
    } catch (error) {
      await this.failEnqueue(id, error, []); // el video de entrada es de la transcripción: no se borra
    }
    return toView(job);
  }

  private parseBurnOptions(raw: unknown): BurnJob["options"] {
    const value = raw ?? {};
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("Las opciones deben ser un objeto JSON.");
    }
    const given = value as Record<string, unknown>;
    const unknown = Object.keys(given).filter((key) => !BURN_OPTION_KEYS.includes(key));
    if (unknown.length > 0) throw new BadRequestException(`Opciones desconocidas: ${unknown.join(", ")}.`);
    const style = given.style ?? "modern";
    const karaoke = given.karaoke ?? false;
    if (typeof style !== "string" || !(BURN_STYLES as readonly string[]).includes(style)) {
      throw new BadRequestException(`style debe ser uno de: ${BURN_STYLES.join(", ")}.`);
    }
    if (typeof karaoke !== "boolean") throw new BadRequestException("karaoke debe ser verdadero o falso.");
    const options: BurnJob["options"] = { style: style as BurnJob["options"]["style"], karaoke };
    // Plantilla y lienzo se eligen de una lista cerrada: nunca viajan al filtro de ffmpeg como texto del usuario.
    if (given.template !== undefined) {
      if (typeof given.template !== "string" || !(BURN_TEMPLATES as readonly string[]).includes(given.template)) {
        throw new BadRequestException(`template debe ser uno de: ${BURN_TEMPLATES.join(", ")}.`);
      }
      options.template = given.template as NonNullable<BurnJob["options"]["template"]>;
    }
    if (given.canvas !== undefined) {
      if (typeof given.canvas !== "string" || !(BURN_CANVASES as readonly string[]).includes(given.canvas)) {
        throw new BadRequestException(`canvas debe ser uno de: ${BURN_CANVASES.join(", ")}.`);
      }
      options.canvas = given.canvas as NonNullable<BurnJob["options"]["canvas"]>;
    }
    return options;
  }

  /**
   * Traduce los subtítulos de una transcripción (ADR 0020). `argos` es local y gratis; `openai` usa la clave propia del espacio:
   * si no está, 409 `external_key_missing` ANTES de crear nada ni encolar (falla rápido, sin gastar). Los topes de caracteres y de
   * segmentos se aplican aquí (413 `job_too_large`) y el worker los vuelve a comprobar.
   */
  async createTranslate(tenantId: string, parentId: string, rawOptions: unknown): Promise<JobView> {
    const options = this.parseTranslateOptions(rawOptions);
    const { job: parent, segmentsKey } = await this.completedTranscription(tenantId, parentId);
    const detected = (parent.result as { detectedLanguage?: unknown } | null)?.detectedLanguage;
    if (typeof detected !== "string" || !/^[a-z]{2,3}$/.test(detected)) {
      throw new ConflictException("La transcripción no tiene un idioma detectado del que traducir.");
    }
    if (detected === options.targetLanguage) {
      throw coded(BadRequestException, 400, "Bad Request", "same_language", "Los subtítulos ya están en ese idioma.");
    }

    const { segments, etag } = await this.readSegments(segmentsKey);
    this.assertSpendingCaps(segments);
    if (options.provider !== "argos") await this.requireExternalKey(tenantId, options.provider);

    const active = await this.prisma.job.count({
      where: { tenantId, kind: "TRANSLATE", parentJobId: parent.id, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (active > 0) throw new ConflictException("Ya hay una traducción en curso para esta transcripción. Espera a que termine o cancélala.");

    const id = randomUUID();
    const outputPrefix = `jobs/${id}/out/`;
    const payload: TranslateJob = {
      schemaVersion: 1,
      jobId: id,
      requestedAt: new Date().toISOString(),
      segments: { bucket: this.storage.bucket, objectKey: segmentsKey, etag },
      outputPrefix,
      options: { provider: options.provider, sourceLanguage: detected, targetLanguage: options.targetLanguage },
    };
    try {
      assertContract("translate-job.v1", payload);
    } catch (error) {
      if (error instanceof ContractViolation) throw new BadRequestException(error.message);
      throw error;
    }

    // Job.options guarda el proveedor y los idiomas, jamás una clave: es lo que el canal interno compara con lo que pide el worker.
    const job = await this.createDerived({
      data: {
        id,
        tenantId,
        kind: "TRANSLATE",
        parentJobId: parent.id,
        inputBucket: parent.inputBucket,
        inputKey: parent.inputKey,
        originalFilename: parent.originalFilename,
        contentType: parent.contentType,
        sizeBytes: parent.sizeBytes,
        outputPrefix,
        options: payload.options as unknown as Prisma.InputJsonValue,
      },
    }, "Ya hay una traducción en curso para esta transcripción. Espera a que termine o cancélala.");
    try {
      await this.queue.enqueueTranslate(payload);
    } catch (error) {
      await this.failEnqueue(id, error, []); // el video de entrada es de la transcripción: no se borra
    }
    return toView(job);
  }

  /**
   * Dobla la voz de los subtítulos de una transcripción (o de una de sus traducciones terminadas, con `translationId`). Siempre usa un
   * proveedor externo y la clave propia del espacio: sin ella, 409 antes de crear nada. Mismos topes de gasto que traducir.
   */
  async createDub(tenantId: string, parentId: string, rawOptions: unknown): Promise<JobView> {
    const options = this.parseDubOptions(rawOptions);
    const { job: parent, segmentsKey: originalKey } = await this.completedTranscription(tenantId, parentId);
    if (options.mix !== "none" && mediaKindOf(parent.contentType) === "audio") {
      throw coded(BadRequestException, 400, "Bad Request", "mix_not_available_for_audio", "Un audio no tiene video con el que mezclar: el doblaje se entrega solo como pista .mp3.");
    }

    let segmentsKey = originalKey;
    if (options.translationId !== undefined) {
      const translation = await this.require(tenantId, options.translationId);
      if (translation.kind !== "TRANSLATE" || translation.parentJobId !== parent.id) {
        throw new ConflictException("Esa traducción no es de esta transcripción.");
      }
      if (translation.status !== "COMPLETED") throw new ConflictException("La traducción todavía no terminó.");
      const key = (translation.result as { artifacts?: { segments?: { objectKey?: unknown } } } | null)?.artifacts?.segments?.objectKey;
      if (typeof key !== "string" || !key.startsWith(translation.outputPrefix) || key.includes("..")) {
        throw new ConflictException("La traducción no tiene subtítulos disponibles.");
      }
      segmentsKey = key;
    }
    const head = await this.storage.head(segmentsKey);
    if (!head) throw new ConflictException("Los subtítulos ya no están disponibles (caducaron).");
    const { segments } = await this.readSegments(segmentsKey);
    this.assertSpendingCaps(segments);
    await this.requireExternalKey(tenantId, options.provider);

    const active = await this.prisma.job.count({
      where: { tenantId, kind: "DUB", parentJobId: parent.id, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (active > 0) throw new ConflictException("Ya hay un doblaje en curso para esta transcripción. Espera a que termine o cancélalo.");

    const id = randomUUID();
    const outputPrefix = `jobs/${id}/out/`;
    const payload: DubJob = {
      schemaVersion: 1,
      jobId: id,
      requestedAt: new Date().toISOString(),
      input: { bucket: parent.inputBucket, objectKey: parent.inputKey },
      segments: { bucket: this.storage.bucket, objectKey: segmentsKey, etag: head.etag },
      outputPrefix,
      options: { provider: options.provider, voice: options.voice, mix: options.mix },
    };
    try {
      assertContract("dub-job.v1", payload);
    } catch (error) {
      if (error instanceof ContractViolation) throw new BadRequestException(error.message);
      throw error;
    }

    const job = await this.createDerived({
      data: {
        id,
        tenantId,
        kind: "DUB",
        parentJobId: parent.id,
        inputBucket: parent.inputBucket,
        inputKey: parent.inputKey,
        originalFilename: parent.originalFilename,
        contentType: parent.contentType,
        sizeBytes: parent.sizeBytes,
        outputPrefix,
        options: payload.options as unknown as Prisma.InputJsonValue,
      },
    }, "Ya hay un doblaje en curso para esta transcripción. Espera a que termine o cancélalo.");
    try {
      await this.queue.enqueueDub(payload);
    } catch (error) {
      await this.failEnqueue(id, error, []); // el video de entrada es de la transcripción: no se borra
    }
    return toView(job);
  }

  private parseDubOptions(raw: unknown): { provider: DubJob["options"]["provider"]; voice: string; mix: DubJob["options"]["mix"]; translationId?: string } {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Las opciones deben ser un objeto JSON.");
    const given = raw as Record<string, unknown>;
    const unknown = Object.keys(given).filter((key) => !["provider", "voice", "mix", "translationId"].includes(key));
    if (unknown.length > 0) throw new BadRequestException(`Opciones desconocidas: ${unknown.join(", ")}.`);
    const provider = given.provider;
    if (provider !== "openai" && provider !== "elevenlabs") throw new BadRequestException("provider debe ser: openai, elevenlabs.");
    const voice = given.voice;
    if (typeof voice !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(voice)) {
      throw new BadRequestException("voice debe ser el identificador de una voz del proveedor (letras, números, guion y guion bajo; hasta 64).");
    }
    const mix = given.mix ?? "none";
    if (mix !== "none" && mix !== "replace" && mix !== "duck") throw new BadRequestException("mix debe ser: none, replace, duck.");
    const translationId = given.translationId;
    if (translationId !== undefined && (typeof translationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(translationId))) {
      throw new BadRequestException("translationId debe ser el id de una traducción.");
    }
    return { provider, voice, mix, ...(translationId === undefined ? {} : { translationId }) };
  }

  private parseTranslateOptions(raw: unknown): { provider: TranslateJob["options"]["provider"]; targetLanguage: string } {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Las opciones deben ser un objeto JSON.");
    const given = raw as Record<string, unknown>;
    const unknown = Object.keys(given).filter((key) => key !== "provider" && key !== "targetLanguage");
    if (unknown.length > 0) throw new BadRequestException(`Opciones desconocidas: ${unknown.join(", ")}.`);
    const provider = given.provider ?? "argos";
    if (provider !== "argos" && provider !== "openai") throw new BadRequestException("provider debe ser: argos, openai.");
    const target = given.targetLanguage;
    if (typeof target !== "string" || !/^[a-z]{2,3}$/.test(target)) throw new BadRequestException("targetLanguage debe ser un código de idioma en minúsculas (p. ej. es).");
    return { provider, targetLanguage: target };
  }

  /** Topes de gasto (ADR 0020 §7): un trabajo que los excede se rechaza antes de pedir nada al proveedor. */
  private assertSpendingCaps(segments: Segment[]): void {
    const characters = segments.reduce((sum, segment) => sum + segment.text.trim().length, 0);
    const { maxJobCharacters, maxJobSegments } = this.config.ai;
    if (segments.length > maxJobSegments || characters > maxJobCharacters) {
      throw coded(
        PayloadTooLargeException,
        413,
        "Payload Too Large",
        "job_too_large",
        `El trabajo tiene ${segments.length} segmentos y ${characters} caracteres; el máximo es ${maxJobSegments} segmentos y ${maxJobCharacters} caracteres.`,
      );
    }
  }

  /** 409 antes de encolar: sin clave del proveedor el trabajo fallaría en el worker después de ocupar la cola. */
  private async requireExternalKey(tenantId: string, provider: "openai" | "elevenlabs"): Promise<void> {
    if (!this.externalKeys.enabled) {
      throw coded(ConflictException, 409, "Conflict", "byok_disabled", "Las claves externas propias no están activadas en este servidor.");
    }
    if (!(await this.externalKeys.has(tenantId, provider))) {
      throw coded(ConflictException, 409, "Conflict", "external_key_missing", "Falta la clave del proveedor. Un Dueño del espacio debe guardarla antes.");
    }
  }

  async get(tenantId: string, id: string): Promise<JobView> {
    return toView(await this.require(tenantId, id));
  }

  /**
   * Los trabajos del tenant, del más reciente al más antiguo. `cursor` es el id del último de la página anterior: debe
   * ser del mismo tenant (si no, 404 como en cualquier otra consulta).
   */
  async list(tenantId: string, { limit: requested, cursor }: { limit: number; cursor?: string }): Promise<{ jobs: JobView[]; nextCursor: string | null }> {
    // Tope propio del servicio: aunque otro llamador pida de más, la consulta nunca trae más de MAX_LIST_LIMIT + 1 filas.
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIST_LIMIT) : 1;
    if (cursor !== undefined) await this.require(tenantId, cursor);
    const rows = await this.prisma.job.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    const page = rows.slice(0, limit);
    return { jobs: page.map(toView), nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /** Para el stream de eventos: null = no existe (o es de otro tenant). */
  async find(tenantId: string, id: string): Promise<Job | null> {
    return this.prisma.job.findFirst({ where: { id, tenantId } });
  }

  async cancel(tenantId: string, id: string): Promise<JobView> {
    const job = await this.require(tenantId, id);
    if (isTerminal(job.status)) {
      throw new ConflictException(`El trabajo ya terminó (${job.status}).`);
    }
    // La transición QUEUED -> CANCELLED es la que decide la carrera con el worker: su `claim` es la
    // misma comparación (UPDATE ... WHERE status = 'QUEUED'), así que solo uno de los dos gana. Antes
    // se quitaba el trabajo de la cola y luego se actualizaba la fila: si el worker lo tomaba entre
    // ambos pasos, la fila quedaba CANCELLED mientras el video se procesaba entero.
    const cancelled = await this.prisma.job.updateMany({
      where: { id, tenantId, status: "QUEUED" },
      data: { status: "CANCELLED", errorCode: "CANCELLED", errorMessage: "Cancelado por el usuario.", finishedAt: new Date() },
    });
    if (cancelled.count === 1) {
      // Ganó el API: el worker, si llega a recibirlo, ve que ya no está QUEUED y lo omite. Quitarlo
      // de la cola es solo limpieza, por eso un fallo aquí no se propaga.
      await this.queue.removeIfWaiting(job.kind, id).catch((e: unknown) =>
        this.logger.warn(`No se pudo quitar ${id} de la cola: ${(e as Error).message}`),
      );
      return toView(await this.require(tenantId, id));
    }
    // Perdió: el worker ya lo tomó (o terminó entre la lectura y aquí). Se relee y se avisa al worker.
    const current = await this.require(tenantId, id);
    if (isTerminal(current.status)) {
      throw new ConflictException(`El trabajo ya terminó (${current.status}).`);
    }
    const receivers = await this.queue.requestCancel(id).catch((error: unknown) => {
      this.logger.error(`No se pudo publicar la cancelación de ${id}: ${(error as Error).message}`);
      throw new ServiceUnavailableException("No se pudo avisar al worker. Inténtalo de nuevo en un momento.");
    });
    if (receivers === 0) {
      // Pub/sub no guarda historial: sin ningún worker escuchando, el aviso se pierde.
      this.logger.warn(`La cancelación de ${id} no la recibió ningún worker.`);
      throw new ServiceUnavailableException("Ningún worker está escuchando; la cancelación no se pudo entregar.");
    }
    return toView(current);
  }

  /**
   * Devuelve la clave de un artefacto del resultado, o null si el trabajo aún no lo tiene.
   * El resultado lo escribe el worker; aun así solo se sirven claves bajo el prefijo de salida de
   * este trabajo, para que un resultado corrupto no pueda exponer objetos de otro trabajo.
   */
  async artifactKey(tenantId: string, id: string, name: string): Promise<{ key: string; filename: string } | null> {
    const job = await this.require(tenantId, id);
    if (job.status !== "COMPLETED") return null;
    if (name === "source") {
      // El audio original, para escucharlo mientras se editan los subtítulos. Solo el de una transcripción de audio: el de un video no se sirve.
      if (job.kind !== "TRANSCRIBE" || mediaKindOf(job.contentType) !== "audio" || !job.inputKey.startsWith(`jobs/${job.id}/input`) || job.inputKey.includes("..")) return null;
      return { key: job.inputKey, filename: job.originalFilename };
    }
    if (!ARTIFACTS_BY_KIND[job.kind].includes(name)) return null;
    const artifacts = (job.result as { artifacts?: Record<string, unknown> } | null)?.artifacts;
    const entry = artifacts?.[name];
    const key = typeof entry === "string" ? entry : (entry as { objectKey?: unknown } | undefined)?.objectKey;
    if (typeof key !== "string" || !key.startsWith(job.outputPrefix) || key.includes("..")) return null;
    return { key, filename: downloadName(job.originalFilename, name, job.kind) };
  }

  private async require(tenantId: string, id: string): Promise<Job> {
    const job = await this.prisma.job.findFirst({ where: { id, tenantId } });
    if (!job) throw new NotFoundException("No existe ese trabajo.");
    return job;
  }

  private parseOptions(raw: unknown): TranscribeJob["options"] {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BadRequestException('El campo "options" debe ser un objeto JSON.');
    }
    const given = raw as Record<string, unknown>;
    // Los valores por defecto se aplican aquí; claves desconocidas las rechaza el contrato.
    const options = { modelSize: "small", sourceLanguage: null, translateTo: null, cleanAudio: false, diarize: false, ...given } as TranscribeJob["options"];
    if (options.diarize === true && !this.config.features.diarization) {
      throw new BadRequestException("Identificar quién habla no está disponible en este servidor.");
    }
    return options;
  }
}
