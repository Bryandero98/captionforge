// Traducir subtítulos (ADR 0020, T7): POST /v1/jobs/:id/translate contra PostgreSQL, Redis y S3 reales (npm run infra:up).
// `argos` es local y no necesita clave; `openai` exige la clave propia del espacio y responde 409 ANTES de encolar si falta.
import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { assertContract } from "../src/contracts/validators.js";
import { ExternalKeyCipher } from "../src/external-keys/external-key-crypto.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { QUEUES } from "../src/queue/names.js";
import { StorageService } from "../src/storage/storage.service.js";
import { disposeTestTenants, sharedTenant } from "./support/tenancy.js";

const APP_SECRET = "7c1e93a5d84f60b15b7e1c93a2d84f60b1e97c35d8a20f46c3b95e17a4d68f02";
const OPENAI_KEY = `sk-canario-${randomUUID().replaceAll("-", "")}`;
const baseConfig = loadConfig();
const connection = { host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password };

const created: string[] = [];
const keys: string[] = [];
let tenantId = "";
let app: Awaited<ReturnType<typeof createApp>>;
let appNoByok: Awaited<ReturnType<typeof createApp>>;
let base = "";
let baseNoByok = "";
let prisma: PrismaService;
let storage: StorageService;
let transcribeQueue: Queue;
let translateQueue: Queue;
let owner: pg.Client;

const SEGMENTS = [
  { start: 0, end: 2, text: " Hola mundo", words: null },
  { start: 2, end: 4, text: " Segunda frase", words: null },
  { start: 4, end: 6, text: " Tercera", words: null },
];

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function completedTranscription(segments: unknown[] = SEGMENTS, detectedLanguage = "es"): Promise<{ id: string; etag: string }> {
  const data = new FormData();
  data.append("file", new File([new Uint8Array(2048).fill(7)], "entrevista.mp4", { type: "video/mp4" }));
  const response = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  created.push(id);
  const segmentsKey = `jobs/${id}/out/segments.json`;
  keys.push(segmentsKey);
  const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(segments)), "application/json");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage,
    device: "cpu",
    durationSeconds: 6,
    segmentCount: segments.length,
    artifacts: {
      srt: `jobs/${id}/out/output.srt`,
      segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag },
      waveform: `jobs/${id}/out/waveform.json`,
    },
  };
  assertContract("transcribe-result.v1", result);
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);
  return { id, etag };
}

async function storeKey(provider: "openai" | "elevenlabs", key: string): Promise<void> {
  await owner.query(
    `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, $3::"ExternalProvider", $4, 1, $5)
     ON CONFLICT ("tenantId", provider) DO NOTHING`,
    [randomUUID(), tenantId, provider, new ExternalKeyCipher(APP_SECRET).encrypt(key, { tenantId, provider, keyVersion: 1 }), key.slice(-4)],
  );
}

const jobCount = async (kind: string): Promise<number> => prisma.job.count({ where: { tenantId, kind: kind as "TRANSLATE" } });

beforeAll(async () => {
  tenantId = (await sharedTenant()).id;
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  app = await createApp({ ...baseConfig, byok: { appSecret: APP_SECRET }, ai: { maxJobCharacters: 120, maxJobSegments: 5 } }, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  appNoByok = await createApp({ ...baseConfig, byok: { appSecret: undefined } }, { logger: ["error"] });
  await appNoByok.listen(0, "127.0.0.1");
  baseNoByok = await appNoByok.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  transcribeQueue = new Queue(QUEUES.transcribe, { connection });
  translateQueue = new Queue(QUEUES.translate, { connection });
}, 60_000);

afterAll(async () => {
  for (const id of created) {
    await (await transcribeQueue.getJob(id))?.remove().catch(() => undefined);
    await (await translateQueue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma.job.findUnique({ where: { id } });
    if (job?.kind === "TRANSCRIBE") await storage.delete(job.inputKey).catch(() => undefined);
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
  await owner.end();
  await transcribeQueue.close();
  await translateQueue.close();
  await app.close();
  await appNoByok.close();
  await disposeTestTenants();
});

describe("POST /v1/jobs/:id/translate con argos (local)", () => {
  it("202: crea el trabajo TRANSLATE, lo encola con un payload válido y sin claves, e informa los idiomas", async () => {
    const { id: parent, etag } = await completedTranscription();
    const response = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" });
    expect(response.status).toBe(202);
    const view = (await response.json()) as { id: string; kind: string; status: string };
    created.push(view.id);
    expect(view).toMatchObject({ kind: "TRANSLATE", status: "QUEUED" });

    const row = await prisma.job.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.parentJobId).toBe(parent);
    expect(row.options).toEqual({ provider: "argos", sourceLanguage: "es", targetLanguage: "en" });

    const queued = await translateQueue.getJob(view.id);
    expect(queued).toBeTruthy();
    assertContract("translate-job.v1", queued!.data);
    expect(queued!.data.segments.etag).toBe(etag);
    expect(queued!.data.segments.objectKey).toBe(`jobs/${parent}/out/segments.json`);
    expect(queued!.data.outputPrefix).toBe(`jobs/${view.id}/out/`);
  });

  it("409 si ya hay una traducción en curso para esa transcripción", async () => {
    const { id: parent } = await completedTranscription();
    const first = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" });
    created.push(((await first.json()) as { id: string }).id);
    const second = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "fr" });
    expect(second.status).toBe(409);
  });

  it("400: mismo idioma, proveedor desconocido, opciones desconocidas, idioma ausente o inválido", async () => {
    const { id: parent } = await completedTranscription();
    const before = await jobCount("TRANSLATE");
    for (const [body, code] of [
      [{ provider: "argos", targetLanguage: "es" }, "same_language"],
      [{ provider: "deepl", targetLanguage: "en" }, undefined],
      [{ provider: "argos", targetLanguage: "en", apiKey: "sk-x" }, undefined],
      [{ provider: "argos" }, undefined],
      [{ provider: "argos", targetLanguage: "EN" }, undefined],
      [{ provider: "argos", targetLanguage: "../x" }, undefined],
    ] as const) {
      const response = await post(`${base}/v1/jobs/${parent}/translate`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      if (code) expect(await response.json()).toMatchObject({ code });
    }
    expect(await jobCount("TRANSLATE")).toBe(before);
  });

  it("404 si no existe, 409 si la transcripción no terminó o si el padre no es una transcripción", async () => {
    expect((await post(`${base}/v1/jobs/${randomUUID()}/translate`, { provider: "argos", targetLanguage: "en" })).status).toBe(404);
    const data = new FormData();
    data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
    const { id: pending } = (await (await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data })).json()) as { id: string };
    created.push(pending);
    expect((await post(`${base}/v1/jobs/${pending}/translate`, { provider: "argos", targetLanguage: "en" })).status).toBe(409);

    const { id: parent } = await completedTranscription();
    const child = (await (await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" })).json()) as { id: string };
    created.push(child.id);
    expect((await post(`${base}/v1/jobs/${child.id}/translate`, { provider: "argos", targetLanguage: "fr" })).status).toBe(409);
  });

  it("413 job_too_large si excede los topes de gasto, sin crear ni encolar nada", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ start: i, end: i + 0.9, text: `x${i}`, words: null }));
    const long = [{ start: 0, end: 2, text: "a".repeat(121), words: null }];
    const before = await jobCount("TRANSLATE");
    for (const segments of [many, long]) {
      const { id: parent } = await completedTranscription(segments);
      const response = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "job_too_large" });
    }
    expect(await jobCount("TRANSLATE")).toBe(before);
  });

  it("cancelar un TRANSLATE en cola lo quita de SU cola", async () => {
    const { id: parent } = await completedTranscription();
    const { id } = (await (await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" })).json()) as { id: string };
    created.push(id);
    expect(await translateQueue.getJob(id)).toBeTruthy();
    const cancelled = await fetch(`${base}/v1/jobs/${id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBeLessThan(300);
    expect(await translateQueue.getJob(id)).toBeUndefined();
  });

  it("descarga la traducción terminada como `segments` (solo bajo el prefijo del propio trabajo)", async () => {
    const { id: parent } = await completedTranscription();
    const { id } = (await (await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" })).json()) as { id: string };
    created.push(id);
    const key = `jobs/${id}/out/translated-segments.json`;
    keys.push(key);
    const { etag } = await storage.putBuffer(key, Buffer.from(JSON.stringify([{ start: 0, end: 2, text: "Hello world", words: null }])), "application/json");
    const result = {
      schemaVersion: 1,
      jobId: id,
      provider: "argos",
      sourceLanguage: "es",
      targetLanguage: "en",
      segmentCount: 1,
      characters: 10,
      artifacts: { segments: { bucket: baseConfig.s3.bucket, objectKey: key, etag } },
    };
    assertContract("translate-result.v1", result);
    await owner.query(`UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "finishedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);

    const download = await fetch(`${base}/v1/jobs/${id}/artifacts/segments`);
    expect(download.status).toBe(200);
    expect(await download.json()).toEqual([{ start: 0, end: 2, text: "Hello world", words: null }]);
    expect(download.headers.get("content-disposition")).toContain("entrevista");
    expect((await fetch(`${base}/v1/jobs/${id}/artifacts/srt`)).status).toBe(404);
  });
});

describe("POST /v1/jobs/:id/translate con openai (clave propia del espacio)", () => {
  it("409 external_key_missing ANTES de crear o encolar nada si el espacio no tiene la clave", async () => {
    await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
    const { id: parent } = await completedTranscription();
    const before = await jobCount("TRANSLATE");
    const response = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "openai", targetLanguage: "en" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "external_key_missing" });
    expect(await jobCount("TRANSLATE")).toBe(before);
    expect((await translateQueue.getJobs(["waiting", "delayed", "prioritized"])).some((job) => job.data?.segments?.objectKey?.includes(parent))).toBe(false);
  });

  it("202 con la clave guardada; el payload de la cola y la fila no llevan la clave ni su cifrado", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const response = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "openai", targetLanguage: "en" });
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    created.push(id);
    const row = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(row.options).toEqual({ provider: "openai", sourceLanguage: "es", targetLanguage: "en" });
    const queued = await translateQueue.getJob(id);
    assertContract("translate-job.v1", queued!.data);
    const everything = JSON.stringify({ data: queued!.data, row }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    expect(everything).not.toContain(OPENAI_KEY);
    expect(everything).not.toContain(OPENAI_KEY.slice(3, 28));
  });

  it("409 byok_disabled si el servidor no tiene APP_SECRET", async () => {
    const { id: parent } = await completedTranscription();
    const response = await post(`${baseNoByok}/v1/jobs/${parent}/translate`, { provider: "openai", targetLanguage: "en" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "byok_disabled" });
    // argos sigue funcionando sin APP_SECRET: la función local no depende de las claves.
    const local = await post(`${baseNoByok}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" });
    expect(local.status).toBe(202);
    created.push(((await local.json()) as { id: string }).id);
  });
});
