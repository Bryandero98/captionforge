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
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
  UnsupportedMediaTypeException,
  type MessageEvent,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable } from "rxjs";

import { clientKey } from "../security/client-key.js";
import { ConnectionLimits } from "../security/connection-limits.js";
import { StorageService } from "../storage/storage.service.js";
import { JobIdPipe } from "./job-id.pipe.js";
import { JobsService, contentDisposition, isTerminal, toView, type JobView } from "./jobs.service.js";

const ARTIFACTS = ["srt", "segments", "waveform", "video"] as const;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;

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
  async transcribe(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<JobView> {
    if (!req.isMultipart()) throw new UnsupportedMediaTypeException("Se esperaba multipart/form-data.");

    // Cada subida retiene ~15 MiB de partes en memoria: sin tope, unas cuantas a la vez agotan el contenedor.
    const slot = this.limits.uploads.tryAcquire(clientKey(req.ip));
    if ("denied" in slot) {
      // El cuerpo no se ha leído: se cierra la conexión en vez de dejar al cliente enviándolo a nadie.
      reply.header("retry-after", "10").header("connection", "close");
      throw slot.denied === "key"
        ? new HttpException("Ya tienes demasiadas subidas en curso; espera a que termine alguna.", HttpStatus.TOO_MANY_REQUESTS)
        : new ServiceUnavailableException("Hay demasiadas subidas en curso; reintenta en unos segundos.");
    }
    try {
      return await this.receiveUpload(req);
    } finally {
      slot.release();
    }
  }

  private async receiveUpload(req: FastifyRequest): Promise<JobView> {
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
      return this.jobs.createTranscription({
        stream: part.file,
        filename: part.filename,
        mimetype: part.mimetype,
        options,
      });
    }
    throw new BadRequestException('Falta el campo "file".');
  }

  @Get(":id")
  get(@Param("id", JobIdPipe) id: string): Promise<JobView> {
    return this.jobs.get(id);
  }

  @Post(":id/cancel")
  @HttpCode(202)
  cancel(@Param("id", JobIdPipe) id: string): Promise<JobView> {
    return this.jobs.cancel(id);
  }

  /**
   * Eventos del trabajo (SSE). El estado lo escribe el worker en PostgreSQL; aquí se consulta cada
   * segundo y solo se emite cuando algo cambió. Termina al llegar a un estado final.
   */
  @Sse(":id/events")
  async events(
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
      await this.jobs.get(id);
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
          const job = await this.jobs.find(id);
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
  segments(@Param("id", JobIdPipe) id: string): Promise<unknown> {
    return this.jobs.getSegments(id);
  }

  /**
   * Edita texto y/o tiempos por índice: { "segments": [ { "index": 0, "text": "..." } ], "etag": "..." }.
   * El `etag` es opcional; si se manda y los subtítulos cambiaron, responde 409.
   */
  @Put(":id/segments")
  updateSegments(@Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<unknown> {
    return this.jobs.updateSegments(id, body);
  }

  /** Quema los subtítulos actuales sobre el video: { "style": "modern", "karaoke": false } (ambos opcionales). */
  @Post(":id/burn")
  @HttpCode(202)
  burn(@Param("id", JobIdPipe) id: string, @Body() body: unknown): Promise<JobView> {
    return this.jobs.createBurn(id, body);
  }

  @Get(":id/artifacts/:name")
  async artifact(
    @Param("id", JobIdPipe) id: string,
    @Param("name") name: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!(ARTIFACTS as readonly string[]).includes(name)) {
      throw new NotFoundException("Artefacto desconocido.");
    }
    const artifact = await this.jobs.artifactKey(id, name);
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
