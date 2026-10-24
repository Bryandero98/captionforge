import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
  UnsupportedMediaTypeException,
  UseInterceptors,
  type MessageEvent,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable } from "rxjs";

import { clientKey } from "../security/client-key.js";
import { ConnectionLimits } from "../security/connection-limits.js";
import { Quota, TenantQuotaInterceptor } from "../quota/tenant-quota.interceptor.js";
import { StorageService } from "../storage/storage.service.js";
import { TenantId } from "../tenancy/tenant-auth.guard.js";
import { JobIdPipe } from "./job-id.pipe.js";
import { JobsService, contentDisposition, isTerminal, toView, type JobView } from "./jobs.service.js";

const ARTIFACTS = ["srt", "segments", "waveform", "video", "audio"] as const;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
const jobIdPipe = new JobIdPipe();

@Controller("v1/jobs")
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    private readonly limits: ConnectionLimits,
  ) {}

  /**
   * multipart/form-data. El campo "options" (JSON, opcional) debe ir ANTES del campo "file": el
   * archivo se sube a S3 mientras llega, sin guardarlo en el servidor.
   */
  @Post("transcribe")
  @HttpCode(202)
  @UseInterceptors(TenantQuotaInterceptor)
  @Quota("upload")
  async transcribe(
    @TenantId() tenantId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<JobView> {
    if (!req.isMultipart()) throw new UnsupportedMediaTypeException("Se esperaba multipart/form-data.");

    // Cada subida retiene ~15 MiB de partes en memoria: sin tope, unas cuantas a la vez agotan el contenedor.
    const slot = this.limits.uploads.tryAcquire(clientKey(req.ip));
    if ("denied" in slot) {
      // El cuerpo no se ha leído: el descarte acotado de main.ts (discardRemainingBody) lo vacía y corta. Con
      // `connection: close` Node cerraría el socket al responder y el navegador perdería este mensaje.
      reply.header("retry-after", "10");
      throw slot.denied === "key"
        ? new HttpException("Ya tienes demasiadas subidas en curso; espera a que termine alguna.", HttpStatus.TOO_MANY_REQUESTS)
        : new ServiceUnavailableException("Hay demasiadas subidas en curso; reintenta en unos segundos.");
    }
    try {
      return await this.receiveUpload(tenantId, req);
    } finally {
      slot.release();
    }
  }

  private async receiveUpload(tenantId: string, req: FastifyRequest): Promise<JobView> {
    let options: unknown = {};
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "options") {
          try {
            options = JSON.parse(String(part.value));
          } catch {
            throw new BadRequestException('El campo "options" no es JSON válido.');
          }
        }
        continue;
      }
      if (part.fieldname !== "file") {
        part.file.resume();
        continue;
      }
      return this.jobs.createTranscription(tenantId, {
        stream: part.file,
        filename: part.filename,
        mimetype: part.mimetype,
        options,
      });
    }
    throw new BadRequestException('Falta el campo "file".');
  }

  /** Los trabajos del tenant, del más reciente al más antiguo: `?limit=` (1 a 100, por defecto 20) y `?cursor=<id del último>`. */
  @Get()
  list(
    @TenantId() tenantId: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") rawCursor?: string,
  ): Promise<{ jobs: JobView[]; nextCursor: string | null }> {
    const limit = rawLimit === undefined ? DEFAULT_PAGE : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new BadRequestException(`limit debe ser un entero de 1 a ${MAX_PAGE}.`);
    }
    return this.jobs.list(tenantId, { limit, cursor: rawCursor === undefined ? undefined : jobIdPipe.transform(rawCursor) });
  }

  @Get(":id")
  get(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string): Promise<JobView> {
    return this.jobs.get(tenantId, id);
  }

  @Post(":id/cancel")
  @HttpCode(202)
  cancel(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string): Promise<JobView> {
    return this.jobs.cancel(tenantId, id);
  }

  /**
   * Eventos del trabajo (SSE). El estado lo escribe el worker en PostgreSQL; aquí se consulta cada
   * segundo y solo se emite cuando algo cambió. Termina al llegar a un estado final.
   */
  @Sse(":id/events")
  async events(
    @TenantId() tenantId: string,
    @Param("id", JobIdPipe) id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Observable<MessageEvent>> {
    // Cada flujo hace una consulta por segundo mientras el trabajo no termine, y uno en cola puede esperar
    // horas: el límite por minuto cuenta aperturas, no flujos vivos. Se reserva el hueco antes de consultar.
    const { eventStreamMaxMs } = this.limits;
    // El vencimiento es solo una red de seguridad; el hueco se libera al cerrarse la conexión, al fallar y al completarse.
    const slot = this.limits.eventStreams.tryAcquire(clientKey(req.ip), eventStreamMaxMs > 0 ? eventStreamMaxMs + 60_000 : undefined);
    if ("denied" in slot) {
      reply.header("retry-after", "30");
      throw slot.denied === "key"
        ? new HttpException("Demasiados flujos de eventos abiertos desde esta dirección.", HttpStatus.TOO_MANY_REQUESTS)
        : new ServiceUnavailableException("El servidor tiene demasiados flujos de eventos abiertos.");
    }
    // Si el cliente corta mientras se consulta el trabajo, Nest no llega a suscribirse al Observable y su limpieza
    // nunca corre: el cierre de la conexión es la única señal fiable.
    reply.raw.once("close", slot.release);
    try {
      // Antes de abrir el flujo: una vez enviadas las cabeceras 200 ya no se puede responder 404.
      await this.jobs.get(tenantId, id);
    } catch (error) {
      slot.release();
      throw error;
    }
    return new Observable<MessageEvent>((subscriber) => {
      let stopped = false;
      let last = "";
      let lastBeat = Date.now();
      let timer: NodeJS.Timeout | undefined;
      // Tiempo máximo: se cierra el flujo y EventSource reconecta solo (el estado se vuelve a enviar entero).
      const maxDuration = eventStreamMaxMs > 0 ? setTimeout(() => subscriber.complete(), eventStreamMaxMs) : undefined;

      const tick = async (): Promise<void> => {
        try {
          const job = await this.jobs.find(tenantId, id);
          if (stopped) return;
          if (!job) {
            subscriber.error(new NotFoundException("No existe ese trabajo."));
            return;
          }
          const view = toView(job);
          const signature = JSON.stringify([view.status, view.stage, view.percent, view.message]);
          if (signature !== last) {
            last = signature;
            lastBeat = Date.now();
            subscriber.next({ type: "job", data: view });
          } else if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            lastBeat = Date.now();
            subscriber.next({ type: "ping", data: {} });
          }
          if (isTerminal(job.status)) {
            subscriber.complete();
            return;
          }
          timer = setTimeout(() => void tick(), POLL_MS);
        } catch (error) {
          subscriber.error(error);
        }
      };
      void tick();

      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (maxDuration) clearTimeout(maxDuration);
        slot.release();
      };
    });
  }

  /** Los subtítulos actuales de una transcripción terminada, con el `etag` que se pasa al editarlos. */
  @Get(":id/segments")
  segments(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string): Promise<unknown> {
    return this.jobs.getSegments(tenantId, id);
  }

  /**
   * Edita texto y/o tiempos por índice: { "segments": [ { "index": 0, "text": "..." } ], "etag": "..." }.
   * El `etag` es opcional; si se manda y los subtítulos cambiaron, responde 409.
   */
  @Put(":id/segments")
  updateSegments(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<unknown> {
    return this.jobs.updateSegments(tenantId, id, body);
  }

  /** Quema los subtítulos actuales sobre el video: { "style": "modern", "karaoke": false } (ambos opcionales). */
  @Post(":id/burn")
  @HttpCode(202)
  @UseInterceptors(TenantQuotaInterceptor)
  @Quota("queue")
  burn(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<JobView> {
    return this.jobs.createBurn(tenantId, id, body);
  }

  /** Traduce los subtítulos: { "provider": "argos" | "openai", "targetLanguage": "es" }. Con `openai` hace falta la clave del espacio. */
  @Post(":id/translate")
  @HttpCode(202)
  @UseInterceptors(TenantQuotaInterceptor)
  @Quota("queue")
  translate(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<JobView> {
    return this.jobs.createTranslate(tenantId, id, body);
  }

  /** Dobla los subtítulos: { "provider": "openai" | "elevenlabs", "voice": "alloy", "mix": "none" | "replace" | "duck", "translationId"? }. */
  @Post(":id/dub")
  @HttpCode(202)
  @UseInterceptors(TenantQuotaInterceptor)
  @Quota("queue")
  dub(@TenantId() tenantId: string, @Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<JobView> {
    return this.jobs.createDub(tenantId, id, body);
  }

  @Get(":id/artifacts/:name")
  async artifact(
    @TenantId() tenantId: string,
    @Param("id", JobIdPipe) id: string,
    @Param("name") name: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!(ARTIFACTS as readonly string[]).includes(name)) {
      throw new NotFoundException("Artefacto desconocido.");
    }
    const artifact = await this.jobs.artifactKey(tenantId, id, name);
    if (!artifact) throw new NotFoundException("Ese artefacto todavía no existe.");
    // HEAD (Fastify lo expone solo): responder con la cabecera de S3, sin abrir el objeto. Con GetObject el
    // video entero se leía y se descartaba, una amplificación de lectura de S3 a coste casi nulo del cliente.
    if (req.method === "HEAD") {
      const meta = await this.storage.head(artifact.key);
      if (!meta) throw new NotFoundException("Ese artefacto ya no está disponible.");
      // Respuesta cruda: Fastify pone Content-Length: 0 a un HEAD sin cuerpo, y aquí hay que informar el tamaño real.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": meta.contentType ?? "application/octet-stream",
        "Content-Length": meta.size,
        "Accept-Ranges": "bytes",
        "Content-Disposition": contentDisposition(artifact.filename),
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.end();
      return;
    }
    // Range: los navegadores lo piden para reproducir y saltar dentro de un video sin bajarlo entero. Solo se
    // admite un rango simple; cualquier otra forma se ignora (se sirve el objeto entero) en lugar de llegar a S3.
    const range =
      typeof req.headers.range === "string" && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
    let object;
    try {
      object = await this.storage.getStream(artifact.key, range);
    } catch (error) {
      if ((error as { name?: string }).name === "InvalidRange") {
        reply.header("Content-Range", "bytes */" + ((await this.storage.head(artifact.key))?.size ?? 0));
        throw new HttpException("Rango no satisfacible.", 416);
      }
      throw error;
    }
    if (!object) throw new NotFoundException("Ese artefacto ya no está disponible.");

    reply.header("Content-Type", object.contentType ?? "application/octet-stream");
    reply.header("Accept-Ranges", "bytes");
    if (object.contentRange) reply.status(206).header("Content-Range", object.contentRange);
    if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
    reply.header("Content-Disposition", contentDisposition(artifact.filename));
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(object.body);
  }
}
