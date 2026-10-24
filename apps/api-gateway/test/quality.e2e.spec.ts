// Informe de calidad de subtítulos contra la infraestructura REAL (PostgreSQL, Redis, S3). Requiere `npm run infra:up`.
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/main.js";
import { loadConfig } from "../src/config/config.js";
import { assertContract } from "../src/contracts/validators.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { QUEUES } from "../src/queue/names.js";
import { StorageService } from "../src/storage/storage.service.js";
import { disposeTestTenants, sharedTenant } from "./support/tenancy.js";

const config = loadConfig();
const created: string[] = [];
const keys: string[] = [];

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let prisma: PrismaService;
let storage: StorageService;
let transcribeQueue: Queue;
let worker: pg.Client;

const connection = { host: config.redis.host, port: config.redis.port, password: config.redis.password };

const SEGMENTS = [
  { start: 0, end: 2, text: " Hola mundo", words: null },
  { start: 1.5, end: 2.0, text: " " + "x".repeat(40), words: null }, // solapa con el anterior y va demasiado rápido
];

async function completedTranscription(segments: unknown[] = SEGMENTS): Promise<{ id: string; etag: string }> {
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
  return { id, etag };
}

const get = (path: string): Promise<Response> => fetch(`${base}${path}`);

beforeAll(async () => {
  await sharedTenant();
  app = await createApp(config, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  transcribeQueue = new Queue(QUEUES.transcribe, { connection });
  worker = new pg.Client({ connectionString: process.env.DATABASE_URL_WORKER });
  await worker.connect();
});

afterAll(async () => {
  for (const id of created) {
    await (await transcribeQueue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma.job.findUnique({ where: { id } });
    if (job?.kind === "TRANSCRIBE") await storage.delete(job.inputKey).catch(() => undefined);
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await worker.end();
  await transcribeQueue.close();
  await app.close();
  await disposeTestTenants();
});

describe("GET /v1/quality/profiles", () => {
  it("lista los cinco perfiles con sus umbrales", async () => {
    const response = await get("/v1/quality/profiles");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profiles: { id: string; maxCharsPerLine: number }[] };
    expect(body.profiles.map((profile) => profile.id).sort()).toEqual(["accessible", "bbc", "netflix", "netflix-es", "shorts"]);
    expect(body.profiles.find((profile) => profile.id === "netflix")?.maxCharsPerLine).toBe(42);
  });
});

describe("GET /v1/jobs/:id/quality", () => {
  it("devuelve el informe con el etag de los subtítulos medidos", async () => {
    const { id, etag } = await completedTranscription();
    const response = await get(`/v1/jobs/${id}/quality?profile=netflix`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profile: string; etag: string; summary: { segments: number; errors: number; score: number }; issues: { segment: number; rule: string }[] };
    expect(body.profile).toBe("netflix");
    expect(body.etag).toBe(etag);
    expect(body.summary).toMatchObject({ segments: 2, score: 50 });
    expect(body.issues.map((issue) => `${issue.segment}:${issue.rule}`)).toEqual(expect.arrayContaining(["1:overlap", "1:cps"]));
  });

  it("sin ?profile usa netflix; con otro perfil mide con los umbrales de ese perfil", async () => {
    const { id } = await completedTranscription([{ start: 0, end: 3, text: "a".repeat(36), words: null }]);
    const netflix = (await (await get(`/v1/jobs/${id}/quality`)).json()) as { profile: string; issues: unknown[] };
    const shorts = (await (await get(`/v1/jobs/${id}/quality?profile=shorts`)).json()) as { profile: string; issues: { rule: string }[] };
    expect(netflix.profile).toBe("netflix");
    expect(netflix.issues).toEqual([]);
    expect(shorts.issues.map((issue) => issue.rule)).toContain("cpl");
  });

  it("400 con un perfil desconocido; 404 si el trabajo no existe; 409 si la transcripción no terminó", async () => {
    const { id } = await completedTranscription();
    expect((await get(`/v1/jobs/${id}/quality?profile=inventado`)).status).toBe(400);
    expect((await get(`/v1/jobs/00000000-0000-4000-8000-000000000000/quality`)).status).toBe(404);

    const data = new FormData();
    data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
    const pending = (await (await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data })).json()) as { id: string };
    created.push(pending.id);
    expect((await get(`/v1/jobs/${pending.id}/quality`)).status).toBe(409);
  });

  it("no modifica los subtítulos: el etag es el mismo antes y después de medir", async () => {
    const { id, etag } = await completedTranscription();
    await get(`/v1/jobs/${id}/quality?profile=bbc`);
    const after = (await (await get(`/v1/jobs/${id}/segments`)).json()) as { etag: string };
    expect(after.etag).toBe(etag);
  });
});

describe("POST /v1/jobs/:id/quality/fix", () => {
  const LONG = " Esta es una frase bastante larga que no cabe en una sola línea de subtítulo";
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const put = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("propone ediciones, no guarda nada, y aplicarlas con PUT /segments mejora el informe y conserva los tiempos por palabra", async () => {
    const words = [{ start: 0, end: 1, text: " Esta", probability: 0.9 }];
    const { id, etag } = await completedTranscription([
      { start: 0, end: 6, text: LONG, words },
      { start: 6.02, end: 8, text: " Fin", words: null },
    ]);
    const before = (await (await get(`/v1/jobs/${id}/quality?profile=netflix`)).json()) as { summary: { errors: number; warnings: number } };

    const response = await post(`/v1/jobs/${id}/quality/fix`, { profile: "netflix" });
    expect(response.status).toBe(200);
    const fix = (await response.json()) as { etag: string; edits: { index: number; text?: string }[]; before: { errors: number }; after: { errors: number } };
    expect(fix.etag).toBe(etag);
    expect(fix.edits.length).toBeGreaterThan(0);
    expect(fix.after.errors).toBeLessThan(fix.before.errors);
    // proponer no guarda: los subtítulos siguen con el mismo etag
    expect(((await (await get(`/v1/jobs/${id}/segments`)).json()) as { etag: string }).etag).toBe(etag);

    const applied = await put(`/v1/jobs/${id}/segments`, { segments: fix.edits, etag: fix.etag });
    expect(applied.status).toBe(200);
    const stored = (await applied.json()) as { segments: { text: string; words: unknown }[] };
    expect(stored.segments[0]!.text).toContain("\n");
    expect(stored.segments[0]!.text.replace(/\n/g, " ")).toBe(LONG.trim());
    expect(stored.segments[0]!.words).toEqual(words); // solo cambiaron saltos de línea y tiempos: las palabras se conservan

    const after = (await (await get(`/v1/jobs/${id}/quality?profile=netflix`)).json()) as { summary: { errors: number; warnings: number } };
    expect(after.summary.errors + after.summary.warnings).toBeLessThan(before.summary.errors + before.summary.warnings);
  });

  it("400 con un perfil desconocido y 409 si los subtítulos cambiaron desde que se calculó la propuesta", async () => {
    const { id } = await completedTranscription([{ start: 0, end: 6, text: LONG, words: null }]);
    expect((await post(`/v1/jobs/${id}/quality/fix`, { profile: "inventado" })).status).toBe(400);
    const fix = (await (await post(`/v1/jobs/${id}/quality/fix`, { profile: "netflix" })).json()) as { etag: string; edits: unknown[] };
    await put(`/v1/jobs/${id}/segments`, { segments: [{ index: 0, text: "Otro texto" }] });
    expect((await put(`/v1/jobs/${id}/segments`, { segments: fix.edits, etag: fix.etag })).status).toBe(409);
  });
});
