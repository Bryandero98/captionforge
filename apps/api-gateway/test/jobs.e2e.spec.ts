// Prueba de extremo a extremo del API contra la infraestructura REAL (PostgreSQL, Redis, S3).
// Requiere `npm run infra:up` y la migración aplicada (`npm run migrate`).
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/main.js";
import { loadConfig } from "../src/config/config.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { StorageService } from "../src/storage/storage.service.js";
import { QUEUES } from "../src/queue/names.js";

const config = loadConfig();
const created: string[] = []; // ids de trabajos creados por estas pruebas, para limpiarlos al final

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let prisma: PrismaService;
let storage: StorageService;
let queue: Queue;
let worker: pg.Client; // hace de worker: actualiza el estado con el rol cf_worker

const VIDEO = new Uint8Array(2048).fill(7); // el contenido no se decodifica en el API

function form(options: unknown, file: { name?: string; type?: string; bytes?: Uint8Array } = {}): FormData {
  const data = new FormData();
  if (options !== undefined) data.append("options", typeof options === "string" ? options : JSON.stringify(options));
  data.append("file", new File([file.bytes ?? VIDEO], file.name ?? "entrevista.mp4", { type: file.type ?? "video/mp4" }));
  return data;
}

async function upload(options: unknown = {}, file = {}): Promise<Response> {
  return fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: form(options, file) });
}

async function createJob(options: unknown = {}): Promise<{ id: string; [k: string]: unknown }> {
  const response = await upload(options);
  expect(response.status).toBe(202);
  const job = (await response.json()) as { id: string };
  created.push(job.id);
  return job;
}

beforeAll(async () => {
  app = await createApp(config, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  queue = new Queue(QUEUES.transcribe, { connection: { host: config.redis.host, port: config.redis.port, password: config.redis.password } });
  worker = new pg.Client({ connectionString: process.env.DATABASE_URL_WORKER });
  await worker.connect();
});

afterAll(async () => {
  for (const id of created) {
    await (await queue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma.job.findUnique({ where: { id } });
    if (job) {
      await storage.delete(job.inputKey).catch(() => undefined);
      await storage.delete(`jobs/${id}/out/output.srt`).catch(() => undefined);
    }
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  await worker.end();
  await queue.close();
  await app.close();
});

describe("GET /health", () => {
  it("responde 200 con la base de datos, Redis y S3 arriba", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", checks: { database: "up", redis: "up", s3: "up" } });
  });
});

describe("POST /v1/jobs/transcribe", () => {
  it("sube el video a S3, crea la fila y encola un trabajo que cumple el contrato", async () => {
    const job = await createJob({ modelSize: "base", sourceLanguage: "es", translateTo: "en" });

    expect(job).toMatchObject({
      kind: "TRANSCRIBE",
      status: "QUEUED",
      percent: 0,
      originalFilename: "entrevista.mp4",
      sizeBytes: VIDEO.length,
      options: { modelSize: "base", sourceLanguage: "es", translateTo: "en" },
      error: null,
    });
    // No se filtran bucket ni claves internas.
    expect(JSON.stringify(job)).not.toContain("inputKey");
    expect(JSON.stringify(job)).not.toContain(config.s3.bucket);

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.inputKey).toBe(`jobs/${job.id}/input.mp4`);
    expect(row.outputPrefix).toBe(`jobs/${job.id}/out/`);

    const stored = await storage.getStream(row.inputKey);
    expect(stored).not.toBeNull();
    let bytes = 0;
    for await (const chunk of stored!.body) bytes += (chunk as Buffer).length;
    expect(bytes).toBe(VIDEO.length);

    const queued = await queue.getJob(job.id);
    expect(queued?.id).toBe(job.id); // el jobId del contrato es el id de BullMQ
    expect(queued?.data).toMatchObject({
      schemaVersion: 1,
      jobId: job.id,
      input: { bucket: config.s3.bucket, objectKey: row.inputKey, contentType: "video/mp4", sizeBytes: VIDEO.length },
      outputPrefix: row.outputPrefix,
      options: { modelSize: "base", sourceLanguage: "es", translateTo: "en" },
    });
    expect(queued?.opts.attempts).toBe(1);
  });

  it("aplica valores por defecto cuando no se mandan opciones", async () => {
    const job = await createJob(undefined);
    expect(job.options).toEqual({ modelSize: "small", sourceLanguage: null, translateTo: null });
  });

  it("rechaza con 400 opciones que no cumplen el contrato, sin dejar nada guardado", async () => {
    const before = await prisma.job.count();
    for (const bad of [{ modelSize: "gigante" }, { sourceLanguage: "ESP" }, { desconocida: 1 }, "no es json", "[1]"]) {
      const response = await upload(bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await prisma.job.count()).toBe(before);
  });

  it("rechaza con 415 un tipo de archivo no admitido", async () => {
    const response = await upload({}, { type: "application/x-msdownload", name: "virus.exe" });
    expect(response.status).toBe(415);
  });

  it("rechaza con 400 un archivo vacío y no deja objetos huérfanos", async () => {
    const before = await prisma.job.count();
    const response = await upload({}, { bytes: new Uint8Array(0) });
    expect(response.status).toBe(400);
    expect(await prisma.job.count()).toBe(before);
  });

  it("rechaza con 415 una petición que no es multipart", async () => {
    const response = await fetch(`${base}/v1/jobs/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(415);
  });

  it("usa solo el último segmento del nombre y nunca construye rutas con él", async () => {
    const job = await createJob();
    const response = await fetch(`${base}/v1/jobs/transcribe`, {
      method: "POST",
      body: (() => {
        const data = new FormData();
        data.append("file", new File([VIDEO], "..\\..\\etc/pasa wd.MP4", { type: "video/mp4" }));
        return data;
      })(),
    });
    expect(response.status).toBe(202);
    const created2 = (await response.json()) as { id: string; originalFilename: string };
    created.push(created2.id);
    expect(created2.originalFilename).toBe("pasa wd.MP4");
    const row = await prisma.job.findUniqueOrThrow({ where: { id: created2.id } });
    expect(row.inputKey).toBe(`jobs/${created2.id}/input.mp4`);
    expect(job.id).not.toBe(created2.id);
  });
});

describe("límite de tamaño (413)", () => {
  it("aborta la subida al pasar MAX_UPLOAD_BYTES y borra lo ya subido", async () => {
    const small = await createApp({ ...config, maxUploadBytes: 1024 }, { logger: ["error"] });
    await small.listen(0, "127.0.0.1");
    try {
      const before = await prisma.job.count();
      const response = await fetch(`${await small.getUrl()}/v1/jobs/transcribe`, { method: "POST", body: form({}) });
      expect(response.status).toBe(413);
      expect(await prisma.job.count()).toBe(before);
    } finally {
      await small.close();
    }
  });
});

describe("GET /v1/jobs/:id", () => {
  it("devuelve el trabajo, y 404 / 400 para ids desconocidos o mal formados", async () => {
    const job = await createJob();
    expect((await fetch(`${base}/v1/jobs/${job.id}`)).status).toBe(200);
    expect((await fetch(`${base}/v1/jobs/${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${base}/v1/jobs/no-es-uuid`)).status).toBe(400);
  });

  it("refleja lo que escribe el worker con su rol de columnas acotadas", async () => {
    const job = await createJob();
    await worker.query(
      `UPDATE "Job" SET status = 'RUNNING', stage = 'transcribing', percent = 37.5, message = 'Transcribiendo',
        "startedAt" = now(), "updatedAt" = now() WHERE id = $1`,
      [job.id],
    );
    const view = (await (await fetch(`${base}/v1/jobs/${job.id}`)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ status: "RUNNING", stage: "transcribing", percent: 37.5, message: "Transcribiendo" });
    expect(view.startedAt).not.toBeNull();
  });
});

describe("POST /v1/jobs/:id/cancel", () => {
  it("si el trabajo aún no lo tomó nadie, lo quita de la cola y lo marca CANCELLED", async () => {
    const job = await createJob();
    const response = await fetch(`${base}/v1/jobs/${job.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "CANCELLED", error: { code: "CANCELLED" } });
    expect(await queue.getJob(job.id)).toBeUndefined();
  });

  it("si ya corre, publica el mensaje de cancelación del contrato y deja que el worker lo termine", async () => {
    const job = await createJob();
    // Quita el trabajo de la cola para simular que un worker ya lo tomó, y marca RUNNING.
    await (await queue.getJob(job.id))?.remove();
    await worker.query(`UPDATE "Job" SET status = 'RUNNING', "updatedAt" = now() WHERE id = $1`, [job.id]);

    const { Redis } = await import("ioredis");
    const subscriber = new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password });
    const received = new Promise<unknown>((resolve) => {
      subscriber.on("message", (_channel, message) => resolve(JSON.parse(message)));
    });
    await subscriber.subscribe("captionforge:cancel");
    try {
      const response = await fetch(`${base}/v1/jobs/${job.id}/cancel`, { method: "POST" });
      expect(response.status).toBe(202);
      expect(((await response.json()) as { status: string }).status).toBe("RUNNING"); // lo cierra el worker
      expect(await received).toEqual({ schemaVersion: 1, jobId: job.id });
    } finally {
      subscriber.disconnect();
    }
  });

  it("devuelve 409 si el trabajo ya terminó y 404 si no existe", async () => {
    const job = await createJob();
    await fetch(`${base}/v1/jobs/${job.id}/cancel`, { method: "POST" });
    expect((await fetch(`${base}/v1/jobs/${job.id}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${base}/v1/jobs/${randomUUID()}/cancel`, { method: "POST" })).status).toBe(404);
  });
});

describe("GET /v1/jobs/:id/events (SSE)", () => {
  it("emite el estado actual, cada cambio y termina al llegar a un estado final", async () => {
    const job = await createJob();
    const response = await fetch(`${base}/v1/jobs/${job.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Cambios que haría el worker, un poco después de que el cliente se conecte.
    setTimeout(async () => {
      await worker.query(`UPDATE "Job" SET status = 'RUNNING', stage = 'transcribing', percent = 50, "updatedAt" = now() WHERE id = $1`, [job.id]);
      await new Promise((r) => setTimeout(r, 1300));
      await worker.query(`UPDATE "Job" SET status = 'COMPLETED', percent = 100, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [job.id]);
    }, 300);

    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });

    const states = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!) as { status: string; percent: number });
    expect(states.map((s) => s.status)).toEqual(["QUEUED", "RUNNING", "COMPLETED"]);
    expect(states[1]!.percent).toBe(50);
    expect(text).toContain("event: job");
  });

  it("da 404 por ids desconocidos", async () => {
    const response = await fetch(`${base}/v1/jobs/${randomUUID()}/events`);
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/jobs/:id/artifacts/:name", () => {
  it("404 mientras no hay resultado; descarga el artefacto cuando el worker lo publicó", async () => {
    const job = await createJob();
    expect((await fetch(`${base}/v1/jobs/${job.id}/artifacts/srt`)).status).toBe(404);
    expect((await fetch(`${base}/v1/jobs/${job.id}/artifacts/secreto`)).status).toBe(404);

    const srtKey = `jobs/${job.id}/out/output.srt`;
    await storage.putStream(srtKey, Readable.from([Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nHola\n")]), "application/x-subrip");
    const result = {
      schemaVersion: 1,
      jobId: job.id,
      detectedLanguage: "es",
      device: "cpu",
      durationSeconds: 1,
      segmentCount: 1,
      artifacts: {
        srt: srtKey,
        segments: { bucket: config.s3.bucket, objectKey: `jobs/${job.id}/out/segments.json`, etag: "9b2cf535f27731c974343645a3985328" },
        waveform: `jobs/${job.id}/out/waveform.json`,
      },
    };
    await worker.query(`UPDATE "Job" SET status = 'COMPLETED', result = $2::jsonb, "updatedAt" = now() WHERE id = $1`, [job.id, JSON.stringify(result)]);

    const response = await fetch(`${base}/v1/jobs/${job.id}/artifacts/srt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="output.srt"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("Hola");
    // segments.json declarado pero aún no subido: 404, no 500.
    expect((await fetch(`${base}/v1/jobs/${job.id}/artifacts/segments`)).status).toBe(404);
  });
});
