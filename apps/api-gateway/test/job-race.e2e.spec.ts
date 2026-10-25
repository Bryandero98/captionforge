// Carreras en los trabajos derivados: con varias peticiones simultáneas sobre la misma transcripción solo UNA crea el trabajo (quemar, traducir,
// doblar); las demás reciben 409. Antes, count() y create() no eran atómicos y dos peticiones podían encolar dos trabajos idénticos.
// Contra PostgreSQL, Redis y S3 reales (npm run infra:up).
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
const baseConfig = loadConfig();
const connection = { host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password };

const created: string[] = [];
const keys: string[] = [];
let tenantId = "";
let app: Awaited<ReturnType<typeof createApp>>;
let base = "";
let prisma: PrismaService;
let storage: StorageService;
let queues: Queue[] = [];
let owner: pg.Client;

const SEGMENTS = [
  { start: 0, end: 2, text: " Hola mundo", words: null },
  { start: 2, end: 4, text: " Segunda frase", words: null },
];

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const upload = (name: string, type: string): Promise<Response> => {
  const data = new FormData();
  data.append("file", new File([new Uint8Array(2048).fill(7)], name, { type }));
  return fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data });
};

/** Una transcripción terminada de un archivo con ese nombre y tipo, como la dejaría el worker. */
async function completedTranscription(name: string, type: string): Promise<string> {
  const response = await upload(name, type);
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  created.push(id);
  const segmentsKey = `jobs/${id}/out/segments.json`;
  keys.push(segmentsKey);
  const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(SEGMENTS)), "application/json");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 4,
    segmentCount: SEGMENTS.length,
    artifacts: {
      srt: `jobs/${id}/out/output.srt`,
      segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag },
      waveform: `jobs/${id}/out/waveform.json`,
    },
  };
  assertContract("transcribe-result.v1", result);
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);
  return id;
}

beforeAll(async () => {
  tenantId = (await sharedTenant()).id;
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  app = await createApp(
    { ...baseConfig, byok: { ...baseConfig.byok, appSecret: APP_SECRET }, security: { ...baseConfig.security, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0 } },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  queues = [new Queue(QUEUES.transcribe, { connection }), new Queue(QUEUES.burn, { connection }), new Queue(QUEUES.dub, { connection })];
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
  await owner.query(
    `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, 'openai'::"ExternalProvider", $3, 1, $4)`,
    [randomUUID(), tenantId, new ExternalKeyCipher(APP_SECRET).encrypt(OPENAI_KEY, { tenantId, provider: "openai", keyVersion: 1 }), OPENAI_KEY.slice(-4)],
  );
}, 60_000);

afterAll(async () => {
  for (const id of created) {
    for (const queue of queues) await (await queue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma.job.findUnique({ where: { id } });
    if (job?.kind === "TRANSCRIBE") await storage.delete(job.inputKey).catch(() => undefined);
    await prisma.job.deleteMany({ where: { parentJobId: id } }).catch(() => undefined);
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
  await owner.end();
  for (const queue of queues) await queue.close();
  await app.close();
  await disposeTestTenants();
});

const PARALLEL = 8;

async function race(path: string, body: unknown, kind: "BURN" | "TRANSLATE" | "DUB", parent: string): Promise<void> {
  const responses = await Promise.all(Array.from({ length: PARALLEL }, () => post(`${base}/v1/jobs/${parent}/${path}`, body)));
  const statuses = responses.map((response) => response.status).sort();
  for (const response of responses) {
    if (response.status === 202) created.push(((await response.json()) as { id: string }).id);
  }
  expect(statuses.filter((status) => status === 202)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(PARALLEL - 1);
  const rows = await prisma.job.findMany({ where: { parentJobId: parent, kind, status: { in: ["QUEUED", "RUNNING"] } } });
  expect(rows).toHaveLength(1);
}

describe("peticiones simultáneas sobre la misma transcripción", () => {
  it("quemar: solo una crea el trabajo", async () => {
    await race("burn", { style: "modern" }, "BURN", await completedTranscription("clase.mp4", "video/mp4"));
  });

  it("traducir: solo una crea el trabajo", async () => {
    await race("translate", { provider: "argos", targetLanguage: "en" }, "TRANSLATE", await completedTranscription("clase.mp4", "video/mp4"));
  });

  it("doblar: solo una crea el trabajo", async () => {
    await race("dub", { provider: "openai", voice: "alloy" }, "DUB", await completedTranscription("clase.mp4", "video/mp4"));
  });

  it("al terminar el activo se puede pedir otro, y los de otra transcripción no se estorban", async () => {
    const one = await completedTranscription("uno.mp4", "video/mp4");
    const two = await completedTranscription("dos.mp4", "video/mp4");
    const first = await post(`${base}/v1/jobs/${one}/burn`, {});
    expect(first.status).toBe(202);
    const firstId = ((await first.json()) as { id: string }).id;
    created.push(firstId);
    expect((await post(`${base}/v1/jobs/${one}/burn`, {})).status).toBe(409);
    const other = await post(`${base}/v1/jobs/${two}/burn`, {});
    expect(other.status).toBe(202);
    created.push(((await other.json()) as { id: string }).id);
    await owner.query(`UPDATE "Job" SET status = 'COMPLETED', "finishedAt" = now() WHERE id = $1`, [firstId]);
    const again = await post(`${base}/v1/jobs/${one}/burn`, {});
    expect(again.status).toBe(202);
    created.push(((await again.json()) as { id: string }).id);
  });
});
