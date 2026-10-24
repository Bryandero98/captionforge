// Doblar (ADR 0020, T9): POST /v1/jobs/:id/dub contra PostgreSQL, Redis y S3 reales (npm run infra:up).
// Siempre usa un proveedor externo con la clave propia del espacio: sin clave, 409 ANTES de crear o encolar nada.
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

const APP_SECRET = "3b95e17a4d68f027c1e93a5d84f60b15b7e1c93a2d84f60b1e97c35d8a20f46c";
const OPENAI_KEY = `sk-canario-${randomUUID().replaceAll("-", "")}`;
const ELEVEN_KEY = `eleven-canario-${randomUUID().replaceAll("-", "")}`;
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
let dubQueue: Queue;
let owner: pg.Client;

const SEGMENTS = [
  { start: 0, end: 2, text: " Hola mundo", words: null },
  { start: 2, end: 4, text: " Segunda frase", words: null },
];

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function completedTranscription(segments: unknown[] = SEGMENTS): Promise<{ id: string; etag: string }> {
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
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 4,
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

/** Una traducción terminada de `parent`, como la dejaría el worker. */
async function completedTranslation(parent: string, status = "COMPLETED"): Promise<{ id: string; etag: string; key: string }> {
  const res = await post(`${base}/v1/jobs/${parent}/translate`, { provider: "argos", targetLanguage: "en" });
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
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
  await owner.query(`UPDATE "Job" SET status = $3::"JobStatus", result = $2::jsonb, "finishedAt" = now() WHERE id = $1`, [id, JSON.stringify(result), status]);
  return { id, etag, key };
}

async function storeKey(provider: "openai" | "elevenlabs", key: string): Promise<void> {
  await owner.query(
    `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, $3::"ExternalProvider", $4, 1, $5)
     ON CONFLICT ("tenantId", provider) DO NOTHING`,
    [randomUUID(), tenantId, provider, new ExternalKeyCipher(APP_SECRET).encrypt(key, { tenantId, provider, keyVersion: 1 }), key.slice(-4)],
  );
}

const jobCount = async (): Promise<number> => prisma.job.count({ where: { tenantId, kind: "DUB" } });

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
  dubQueue = new Queue(QUEUES.dub, { connection });
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
}, 60_000);

afterAll(async () => {
  for (const id of created) {
    for (const queue of [transcribeQueue, dubQueue]) await (await queue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma.job.findUnique({ where: { id } });
    if (job?.kind === "TRANSCRIBE") await storage.delete(job.inputKey).catch(() => undefined);
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
  await owner.end();
  await transcribeQueue.close();
  await dubQueue.close();
  await app.close();
  await appNoByok.close();
  await disposeTestTenants();
});

describe("POST /v1/jobs/:id/dub: la clave del proveedor", () => {
  it("409 external_key_missing ANTES de crear o encolar nada si falta la clave", async () => {
    const { id: parent } = await completedTranscription();
    const before = await jobCount();
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "external_key_missing" });
    expect(await jobCount()).toBe(before);
    expect((await dubQueue.getJobs(["waiting", "delayed", "prioritized"])).some((job) => job.data?.input?.objectKey?.includes(parent))).toBe(false);
  });

  it("cada proveedor exige SU clave: con la de OpenAI guardada, ElevenLabs sigue sin poder", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "external_key_missing" });
  });

  it("409 byok_disabled si el servidor no tiene APP_SECRET", async () => {
    const { id: parent } = await completedTranscription();
    const response = await post(`${baseNoByok}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "byok_disabled" });
  });
});

describe("POST /v1/jobs/:id/dub: crear el trabajo", () => {
  it("202 con la clave guardada: fila DUB, payload válido en SU cola, sin claves y con el video y los subtítulos de la transcripción", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent, etag } = await completedTranscription();
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "nova", mix: "duck" });
    expect(response.status).toBe(202);
    const view = (await response.json()) as { id: string; kind: string; status: string };
    created.push(view.id);
    expect(view).toMatchObject({ kind: "DUB", status: "QUEUED" });

    const row = await prisma.job.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.parentJobId).toBe(parent);
    expect(row.options).toEqual({ provider: "openai", voice: "nova", mix: "duck" });
    const queued = await dubQueue.getJob(view.id);
    expect(queued).toBeTruthy();
    assertContract("dub-job.v1", queued!.data);
    expect(queued!.data.segments).toMatchObject({ objectKey: `jobs/${parent}/out/segments.json`, etag });
    expect(queued!.data.input.objectKey).toBe(row.inputKey);
    const everything = JSON.stringify({ data: queued!.data, row }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    expect(everything).not.toContain(OPENAI_KEY);
    expect(everything).not.toContain(OPENAI_KEY.slice(3, 28));
  });

  it("mix por defecto = none; elevenlabs con su clave también se acepta", async () => {
    await storeKey("elevenlabs", ELEVEN_KEY);
    const { id: parent } = await completedTranscription();
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM" });
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    created.push(id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id } })).options).toEqual({ provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM", mix: "none" });
  });

  it("doblar la TRADUCCIÓN: con translationId usa los segmentos traducidos y su ETag", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const translation = await completedTranslation(parent);
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", translationId: translation.id });
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    created.push(id);
    const queued = await dubQueue.getJob(id);
    expect(queued!.data.segments).toMatchObject({ objectKey: translation.key, etag: translation.etag });
  });

  it("409 si la traducción no terminó o es de otra transcripción; 400 si el id no es válido", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const { id: other } = await completedTranscription();
    const unfinished = await completedTranslation(parent, "FAILED");
    const foreign = await completedTranslation(other);
    expect((await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", translationId: unfinished.id })).status).toBe(409);
    expect((await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", translationId: foreign.id })).status).toBe(409);
    expect((await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", translationId: "no-es-un-uuid" })).status).toBe(400);
    expect((await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", translationId: randomUUID() })).status).toBe(404);
  });

  it("400: proveedor no válido (argos no tiene voz), voz sospechosa, mezcla desconocida u opciones de más", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const before = await jobCount();
    for (const body of [
      { provider: "argos", voice: "alloy" },
      { provider: "deepl", voice: "alloy" },
      { voice: "alloy" },
      { provider: "openai" },
      { provider: "openai", voice: "../alloy" },
      { provider: "openai", voice: "" },
      { provider: "openai", voice: "a".repeat(65) },
      { provider: "openai", voice: "alloy", mix: "overlay" },
      { provider: "openai", voice: "alloy", apiKey: "sk-x" },
    ]) {
      const response = await post(`${base}/v1/jobs/${parent}/dub`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await jobCount()).toBe(before);
  });

  it("409 si ya hay un doblaje en curso para esa transcripción", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const first = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy" });
    created.push(((await first.json()) as { id: string }).id);
    expect((await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "echo" })).status).toBe(409);
  });

  it("404 si no existe y 409 si la transcripción no terminó o el padre no es una transcripción", async () => {
    await storeKey("openai", OPENAI_KEY);
    expect((await post(`${base}/v1/jobs/${randomUUID()}/dub`, { provider: "openai", voice: "alloy" })).status).toBe(404);
    const data = new FormData();
    data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
    const { id: pending } = (await (await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data })).json()) as { id: string };
    created.push(pending);
    expect((await post(`${base}/v1/jobs/${pending}/dub`, { provider: "openai", voice: "alloy" })).status).toBe(409);
    const { id: parent } = await completedTranscription();
    const translation = await completedTranslation(parent);
    expect((await post(`${base}/v1/jobs/${translation.id}/dub`, { provider: "openai", voice: "alloy" })).status).toBe(409);
  });

  it("413 job_too_large si excede los topes de gasto, sin crear ni encolar nada", async () => {
    await storeKey("openai", OPENAI_KEY);
    const many = Array.from({ length: 6 }, (_, i) => ({ start: i, end: i + 0.9, text: `x${i}`, words: null }));
    const long = [{ start: 0, end: 2, text: "a".repeat(121), words: null }];
    const before = await jobCount();
    for (const segments of [many, long]) {
      const { id: parent } = await completedTranscription(segments);
      const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "job_too_large" });
    }
    expect(await jobCount()).toBe(before);
  });

  it("cancelar un DUB en cola lo quita de SU cola", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const { id } = (await (await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy" })).json()) as { id: string };
    created.push(id);
    expect(await dubQueue.getJob(id)).toBeTruthy();
    expect((await fetch(`${base}/v1/jobs/${id}/cancel`, { method: "POST" })).status).toBeLessThan(300);
    expect(await dubQueue.getJob(id)).toBeUndefined();
  });
});

describe("descargar el doblaje", () => {
  it("audio y video del doblaje, con nombre propio, y nada fuera del prefijo del trabajo", async () => {
    await storeKey("openai", OPENAI_KEY);
    const { id: parent } = await completedTranscription();
    const { id } = (await (await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", mix: "replace" })).json()) as { id: string };
    created.push(id);
    const audioKey = `jobs/${id}/out/dub.mp3`;
    const videoKey = `jobs/${id}/out/dubbed.mp4`;
    keys.push(audioKey, videoKey);
    await storage.putBuffer(audioKey, Buffer.from("ID3-audio-falso"), "audio/mpeg");
    await storage.putBuffer(videoKey, Buffer.from("video-falso"), "video/mp4");
    const result = {
      schemaVersion: 1,
      jobId: id,
      provider: "openai",
      mix: "replace",
      segmentCount: 2,
      characters: 25,
      overflowSegments: [],
      artifacts: { audio: audioKey, video: videoKey },
    };
    assertContract("dub-result.v1", result);
    await owner.query(`UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "finishedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);

    const audio = await fetch(`${base}/v1/jobs/${id}/artifacts/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(audio.headers.get("content-disposition")).toContain("entrevista.dub.mp3");
    const video = await fetch(`${base}/v1/jobs/${id}/artifacts/video`);
    expect(video.status).toBe(200);
    expect(video.headers.get("content-disposition")).toContain("entrevista.dubbed.mp4");
    expect((await fetch(`${base}/v1/jobs/${id}/artifacts/srt`)).status).toBe(404);
  });
});
