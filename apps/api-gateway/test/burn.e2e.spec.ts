// Edición de subtítulos, quemado y descarga de videos, contra la infraestructura REAL (PostgreSQL,
// Redis, S3). Requiere `npm run infra:up` y la migración aplicada.
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/main.js";
import { loadConfig } from "../src/config/config.js";
import { assertContract } from "../src/contracts/validators.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { QueueService } from "../src/queue/queue.service.js";
import { QUEUES } from "../src/queue/names.js";
import { StorageService } from "../src/storage/storage.service.js";

const config = loadConfig();
const created: string[] = [];
const keys: string[] = [];

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let prisma: PrismaService;
let storage: StorageService;
let transcribeQueue: Queue;
let burnQueue: Queue;
let worker: pg.Client; // hace de worker: escribe estado y resultado con el rol cf_worker

const connection = { host: config.redis.host, port: config.redis.port, password: config.redis.password };

const SEGMENTS = [
  {
    start: 0,
    end: 2,
    text: " Hola mundo",
    words: [
      { start: 0, end: 1, text: " Hola", probability: 0.9 },
      { start: 1, end: 2, text: " mundo", probability: 0.8 },
    ],
  },
  { start: 2, end: 4, text: " Segunda frase", words: null },
  { start: 4, end: 6, text: " Tercera", words: null },
];

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Crea una transcripción como lo haría el API y la deja COMPLETED como lo haría el worker. */
async function completedTranscription(segments: unknown[] = SEGMENTS): Promise<{ id: string; segmentsKey: string; etag: string }> {
  const data = new FormData();
  data.append("file", new File([new Uint8Array(2048).fill(7)], "entrevista.mp4", { type: "video/mp4" }));
  const response = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  created.push(id);

  const segmentsKey = `jobs/${id}/out/segments.json`;
  const srtKey = `jobs/${id}/out/output.srt`;
  keys.push(segmentsKey, srtKey);
  const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(segments)), "application/json");
  await storage.putBuffer(srtKey, Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nHola mundo\n"), "application/x-subrip");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 6,
    segmentCount: segments.length,
    artifacts: {
      srt: srtKey,
      segments: { bucket: config.s3.bucket, objectKey: segmentsKey, etag },
      waveform: `jobs/${id}/out/waveform.json`,
    },
  };
  assertContract("transcribe-result.v1", result);
  await worker.query(
    `UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [id, JSON.stringify(result)],
  );
  return { id, segmentsKey, etag };
}

const get = async (path: string): Promise<Response> => fetch(`${base}${path}`);
const put = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  app = await createApp(config, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  transcribeQueue = new Queue(QUEUES.transcribe, { connection });
  burnQueue = new Queue(QUEUES.burn, { connection });
  worker = new pg.Client({ connectionString: process.env.DATABASE_URL_WORKER });
  await worker.connect();
});

afterAll(async () => {
  for (const id of created) {
    await (await transcribeQueue.getJob(id))?.remove().catch(() => undefined);
    await (await burnQueue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma.job.findUnique({ where: { id } });
    if (job?.kind === "TRANSCRIBE") await storage.delete(job.inputKey).catch(() => undefined);
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await worker.end();
  await transcribeQueue.close();
  await burnQueue.close();
  await app.close();
});

describe("GET /v1/jobs/:id/segments", () => {
  it("devuelve los subtítulos con índice y el etag que hay que pasar al editarlos", async () => {
    const { id, etag } = await completedTranscription();
    const response = await get(`/v1/jobs/${id}/segments`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { segments: { index: number; text: string }[]; etag: string };
    expect(body.etag).toBe(etag);
    expect(body.segments.map((s) => [s.index, s.text])).toEqual([[0, " Hola mundo"], [1, " Segunda frase"], [2, " Tercera"]]);
  });

  it("409 mientras la transcripción no terminó, 404 si no existe", async () => {
    const data = new FormData();
    data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
    const { id } = (await (await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data })).json()) as { id: string };
    created.push(id);
    expect((await get(`/v1/jobs/${id}/segments`)).status).toBe(409);
    expect((await get(`/v1/jobs/00000000-0000-4000-8000-000000000000/segments`)).status).toBe(404);
  });
});

describe("PUT /v1/jobs/:id/segments", () => {
  it("editar el texto reparte de nuevo los tiempos por palabra; editar solo tiempos los conserva", async () => {
    const { id } = await completedTranscription();
    const response = await put(`/v1/jobs/${id}/segments`, {
      segments: [{ index: 0, text: "  Adiós a todos " }, { index: 1, start: 2.5, end: 4.5 }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { segments: { text: string; start: number; end: number; words: { text: string; probability: number | null }[] | null }[] };
    expect(body.segments[0]!.text).toBe("Adiós a todos");
    expect(body.segments[0]!.words!.map((w) => w.text)).toEqual(["Adiós", "a", "todos"]);
    expect(body.segments[0]!.words!.every((w) => w.probability === null)).toBe(true);
    expect(body.segments[1]).toMatchObject({ start: 2.5, end: 4.5, text: " Segunda frase", words: null });
    expect(body.segments[2]).toMatchObject({ text: " Tercera" }); // intacto
  });

  it("reescribe segments.json y output.srt, y deja el etag nuevo en el resultado", async () => {
    const { id, segmentsKey, etag } = await completedTranscription();
    const response = await put(`/v1/jobs/${id}/segments`, { segments: [{ index: 0, text: "Texto nuevo" }] });
    const { etag: newEtag } = (await response.json()) as { etag: string };

    expect(newEtag).not.toBe(etag);
    expect((await storage.head(segmentsKey))!.etag).toBe(newEtag);
    const stored = JSON.parse((await storage.getBuffer(segmentsKey, 1 << 20))!.body.toString()) as { text: string }[];
    expect(stored[0]!.text).toBe("Texto nuevo");
    const srt = (await storage.getBuffer(`jobs/${id}/out/output.srt`, 1 << 20))!.body.toString();
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:02,000\nTexto nuevo\n\n2\n00:00:02,000 --> 00:00:04,000\nSegunda frase\n\n3\n00:00:04,000 --> 00:00:06,000\nTercera\n");

    const row = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect((row.result as { artifacts: { segments: { etag: string } } }).artifacts.segments.etag).toBe(newEtag);
  });

  it("rechaza con 400 las ediciones inválidas sin tocar nada", async () => {
    const { id, segmentsKey, etag } = await completedTranscription();
    const invalid: unknown[] = [
      { segments: [{ index: 9, text: "x" }] },
      { segments: [{ index: 0, start: 5, end: 1 }] },
      { segments: [{ index: 0, text: 5 }] },
      { segments: [{ index: 0 }, { index: 0 }] },
      { segments: "no" },
      { segments: [], desconocido: true },
      { segments: [{ index: 0, text: "x".repeat(2001) }] },
    ];
    for (const body of invalid) {
      expect((await put(`/v1/jobs/${id}/segments`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await storage.head(segmentsKey))!.etag).toBe(etag);
  });

  it("409 si el etag ya no coincide (alguien editó entre medias) y se aplica con el etag vigente", async () => {
    const { id, etag } = await completedTranscription();
    expect((await put(`/v1/jobs/${id}/segments`, { segments: [{ index: 0, text: "A" }], etag })).status).toBe(200);
    // Con el etag viejo: 409, y no se pisa el cambio de A.
    expect((await put(`/v1/jobs/${id}/segments`, { segments: [{ index: 0, text: "B" }], etag })).status).toBe(409);
    const { segments } = (await (await get(`/v1/jobs/${id}/segments`)).json()) as { segments: { text: string }[] };
    expect(segments[0]!.text).toBe("A");
  });

  it("409 en un trabajo que no es una transcripción terminada", async () => {
    const { id } = await completedTranscription();
    const burn = (await (await fetch(`${base}/v1/jobs/${id}/burn`, json({}))).json()) as { id: string };
    created.push(burn.id);
    expect((await put(`/v1/jobs/${burn.id}/segments`, { segments: [] })).status).toBe(409);
  });
});

describe("POST /v1/jobs/:id/burn", () => {
  it("crea un trabajo BURN enlazado a su transcripción y encola un payload que cumple el contrato", async () => {
    const { id, segmentsKey, etag } = await completedTranscription();
    const response = await fetch(`${base}/v1/jobs/${id}/burn`, json({ style: "tiktok", karaoke: true }));
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; kind: string; parentJobId: string; status: string; options: unknown };
    created.push(job.id);
    expect(job).toMatchObject({ kind: "BURN", parentJobId: id, status: "QUEUED", options: { style: "tiktok", karaoke: true } });

    const queued = await burnQueue.getJob(job.id);
    expect(queued?.data).toMatchObject({
      jobId: job.id,
      input: { bucket: config.s3.bucket, objectKey: `jobs/${id}/input.mp4` },
      segments: { bucket: config.s3.bucket, objectKey: segmentsKey, etag },
      outputPrefix: `jobs/${job.id}/out/`,
      options: { style: "tiktok", karaoke: true },
    });
    assertContract("burn-job.v1", queued!.data);
    expect(queued?.opts.attempts).toBe(1);
    expect(await transcribeQueue.getJob(job.id)).toBeUndefined(); // cola equivocada: no
  });

  it("sin cuerpo usa los valores por defecto", async () => {
    const { id } = await completedTranscription();
    const job = (await (await fetch(`${base}/v1/jobs/${id}/burn`, { method: "POST" })).json()) as { id: string; options: unknown };
    created.push(job.id);
    expect(job.options).toEqual({ style: "modern", karaoke: false });
  });

  it("el quemado lleva el etag de los subtítulos YA editados", async () => {
    const { id, etag } = await completedTranscription();
    await put(`/v1/jobs/${id}/segments`, { segments: [{ index: 0, text: "Corregido" }] });
    const job = (await (await fetch(`${base}/v1/jobs/${id}/burn`, json({}))).json()) as { id: string };
    created.push(job.id);
    const queued = await burnQueue.getJob(job.id);
    const sent = (queued!.data as { segments: { etag: string } }).segments.etag;
    expect(sent).not.toBe(etag);
    expect(sent).toBe((await prisma.job.findUniqueOrThrow({ where: { id } }).then((r) => (r.result as { artifacts: { segments: { etag: string } } }).artifacts.segments.etag)));
  });

  it.each([
    ["estilo desconocido", { style: "neon" }],
    ["karaoke no booleano", { karaoke: "si" }],
    ["opción desconocida", { fuente: "Arial" }],
    ["opciones no objeto", [1]],
  ])("400: %s", async (_name, body) => {
    const { id } = await completedTranscription();
    const before = await prisma.job.count({ where: { kind: "BURN", parentJobId: id } });
    expect((await fetch(`${base}/v1/jobs/${id}/burn`, json(body))).status).toBe(400);
    expect(await prisma.job.count({ where: { kind: "BURN", parentJobId: id } })).toBe(before);
  });

  it("409 si la transcripción no terminó o si el trabajo ya es un quemado; 404 si no existe", async () => {
    const data = new FormData();
    data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
    const pending = (await (await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data })).json()) as { id: string };
    created.push(pending.id);
    expect((await fetch(`${base}/v1/jobs/${pending.id}/burn`, json({}))).status).toBe(409);

    const { id } = await completedTranscription();
    const burn = (await (await fetch(`${base}/v1/jobs/${id}/burn`, json({}))).json()) as { id: string };
    created.push(burn.id);
    expect((await fetch(`${base}/v1/jobs/${burn.id}/burn`, json({}))).status).toBe(409);
    expect((await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000/burn`, json({}))).status).toBe(404);
  });

  it("si la cola falla: 503, el trabajo queda FAILED y no se pierde el video de la transcripción", async () => {
    const { id } = await completedTranscription();
    const spy = vi.spyOn(app.get(QueueService), "enqueueBurn").mockRejectedValue(new Error("redis caído"));
    try {
      const response = await fetch(`${base}/v1/jobs/${id}/burn`, json({}));
      expect(response.status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    const burns = await prisma.job.findMany({ where: { kind: "BURN", parentJobId: id } });
    expect(burns).toHaveLength(1);
    expect(burns[0]).toMatchObject({ status: "FAILED", errorCode: "INTERNAL" });
    created.push(burns[0]!.id);
    expect(await storage.head(`jobs/${id}/input.mp4`)).not.toBeNull();
  });

  it("cancelar un quemado en cola lo saca de SU cola (la de quemado) y lo marca CANCELLED", async () => {
    const { id } = await completedTranscription();
    const job = (await (await fetch(`${base}/v1/jobs/${id}/burn`, json({}))).json()) as { id: string };
    created.push(job.id);
    expect(await burnQueue.getJob(job.id)).toBeDefined();
    const response = await fetch(`${base}/v1/jobs/${job.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { status: string }).status).toBe("CANCELLED");
    expect(await burnQueue.getJob(job.id)).toBeUndefined();
  });
});

describe("GET /v1/jobs/:id/artifacts/video", () => {
  async function completedBurn(): Promise<{ id: string; bytes: Buffer }> {
    const { id: parent } = await completedTranscription();
    const burn = (await (await fetch(`${base}/v1/jobs/${parent}/burn`, json({}))).json()) as { id: string };
    created.push(burn.id);
    const videoKey = `jobs/${burn.id}/out/captioned.mp4`;
    keys.push(videoKey);
    const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    await storage.putBuffer(videoKey, bytes, "video/mp4");
    const result = { schemaVersion: 1, jobId: burn.id, usedKaraoke: false, artifacts: { video: videoKey } };
    assertContract("burn-result.v1", result);
    await worker.query(`UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "updatedAt" = now() WHERE id = $1`, [burn.id, JSON.stringify(result)]);
    return { id: burn.id, bytes };
  }

  it("descarga el video con un nombre derivado del original", async () => {
    const { id, bytes } = await completedBurn();
    const response = await get(`/v1/jobs/${id}/artifacts/video`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-disposition")).toContain('filename="entrevista.captioned.mp4"');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("admite Range (206 con Content-Range) para reproducir y saltar sin bajarlo entero", async () => {
    const { id, bytes } = await completedBurn();
    const response = await fetch(`${base}/v1/jobs/${id}/artifacts/video`, { headers: { range: "bytes=10-19" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 10-19/${bytes.length}`);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("abcdefghij");
  });

  it("416 con un rango fuera del archivo", async () => {
    const { id } = await completedBurn();
    const response = await fetch(`${base}/v1/jobs/${id}/artifacts/video`, { headers: { range: "bytes=9999-99999" } });
    expect(response.status).toBe(416);
  });

  it("los artefactos de una transcripción no existen en un quemado, ni al revés", async () => {
    const { id } = await completedBurn();
    expect((await get(`/v1/jobs/${id}/artifacts/srt`)).status).toBe(404);
    const { id: transcription } = await completedTranscription();
    expect((await get(`/v1/jobs/${transcription}/artifacts/video`)).status).toBe(404);
  });
});

describe("refuerzos de la revisión", () => {
  it("un segundo quemado de la misma transcripción mientras otro está en curso: 409", async () => {
    const { id } = await completedTranscription();
    const first = (await (await fetch(`${base}/v1/jobs/${id}/burn`, json({}))).json()) as { id: string };
    created.push(first.id);
    expect((await fetch(`${base}/v1/jobs/${id}/burn`, json({}))).status).toBe(409);
    // Cuando el primero termina ya se puede pedir otro (otro estilo, por ejemplo).
    await worker.query(`UPDATE "Job" SET status = 'COMPLETED', "updatedAt" = now() WHERE id = $1`, [first.id]);
    const second = await fetch(`${base}/v1/jobs/${id}/burn`, json({ style: "minimal" }));
    expect(second.status).toBe(202);
    created.push(((await second.json()) as { id: string }).id);
  });

  it.each([
    ["línea en blanco (inyectaría subtítulos falsos en el SRT)", { index: 0, text: "hola\n\n99\n00:00:01,000 --> 00:00:02,000\nfalso" }],
    ["tiempo absurdo", { index: 0, start: 0, end: 1e300 }],
  ])("PUT segments rechaza: %s", async (_name, edit) => {
    const { id, etag, segmentsKey } = await completedTranscription();
    expect((await put(`/v1/jobs/${id}/segments`, { segments: [edit] })).status).toBe(400);
    expect((await storage.head(segmentsKey))!.etag).toBe(etag);
  });

  it("HEAD de un artefacto responde con las cabeceras sin leer el objeto de S3", async () => {
    const { id: parent } = await completedTranscription();
    const burn = (await (await fetch(`${base}/v1/jobs/${parent}/burn`, json({}))).json()) as { id: string };
    created.push(burn.id);
    const key = `jobs/${burn.id}/out/captioned.mp4`;
    keys.push(key);
    await storage.putBuffer(key, Buffer.from("0123456789"), "video/mp4");
    const result = { schemaVersion: 1, jobId: burn.id, usedKaraoke: false, artifacts: { video: key } };
    await worker.query(`UPDATE "Job" SET status = 'COMPLETED', result = $2::jsonb, "updatedAt" = now() WHERE id = $1`, [burn.id, JSON.stringify(result)]);

    const read = vi.spyOn(storage, "getStream");
    try {
      const response = await fetch(`${base}/v1/jobs/${burn.id}/artifacts/video`, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("10");
      expect(response.headers.get("content-disposition")).toContain("entrevista.captioned.mp4");
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }

    // Rangos que no son un único "bytes=a-b" se ignoran (se sirve entero) y el 416 informa el tamaño real.
    const multi = await fetch(`${base}/v1/jobs/${burn.id}/artifacts/video`, { headers: { range: "bytes=0-1,5-9" } });
    expect(multi.status).toBe(200);
    expect((await multi.arrayBuffer()).byteLength).toBe(10);
    const out = await fetch(`${base}/v1/jobs/${burn.id}/artifacts/video`, { headers: { range: "bytes=50-60" } });
    expect(out.status).toBe(416);
    expect(out.headers.get("content-range")).toBe("bytes */10");
  });
});
