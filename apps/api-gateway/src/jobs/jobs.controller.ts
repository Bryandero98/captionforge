import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  Sse,
  UnsupportedMediaTypeException,
  type MessageEvent,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable } from "rxjs";

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
  ) {}

  /**
   * multipart/form-data. El campo "options" (JSON, opcional) debe ir ANTES del campo "file": el
   * archivo se sube a S3 mientras llega, sin guardarlo en el servidor.
   */
  @Post("transcribe")
  @HttpCode(202)
  async transcribe(@Req() req: FastifyRequest): Promise<JobView> {
    if (!req.isMultipart()) throw new UnsupportedMediaTypeException("Se esperaba multipart/form-data.");

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
  async events(@Param("id", JobIdPipe) id: string): Promise<Observable<MessageEvent>> {
    // Antes de abrir el flujo: una vez enviadas las cabeceras 200 ya no se puede responder 404.
    await this.jobs.get(id);
    return new Observable<MessageEvent>((subscriber) => {
      let stopped = false;
      let last = "";
      let lastBeat = Date.now();
      let timer: NodeJS.Timeout | undefined;

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
    // Range: los navegadores lo piden para reproducir y saltar dentro de un video sin bajarlo entero.
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    let object;
    try {
      object = await this.storage.getStream(artifact.key, range);
    } catch (error) {
      if ((error as { name?: string }).name === "InvalidRange") throw new HttpException("Rango no satisfacible.", 416);
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
