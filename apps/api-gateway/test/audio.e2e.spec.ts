// Audio universal (Issue #14, Fase 2): MP3, WAV, M4A, OGG y FLAC se suben como un video, el trabajo declara `mediaKind: "audio"`,
// el quemado de subtítulos se rechaza (no hay imagen) y el doblaje solo admite mezcla `none` (no hay video con el que mezclar).
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
  app = await createApp({ ...baseConfig, byok: { ...baseConfig.byok, appSecret: APP_SECRET } }, { logger: ["error"] });
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

describe("subir audio", () => {
  const cases: Array<[string, string, string]> = [
    ["podcast.mp3", "audio/mpeg", "mp3"],
    ["voz.wav", "audio/wav", "wav"],
    ["nota.m4a", "audio/x-m4a", "m4a"],
    ["charla.ogg", "audio/ogg", "ogg"],
    ["musica.flac", "audio/flac", "flac"],
  ];

  it.each(cases)("%s (%s) se acepta, queda como audio y guarda la entrada con su extensión", async (name, type, extension) => {
    const response = await upload(name, type);
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; kind: string; mediaKind: string; originalFilename: string };
    created.push(job.id);
    expect(job).toMatchObject({ kind: "TRANSCRIBE", mediaKind: "audio", originalFilename: name });
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.contentType).toBe(type);
    expect(stored.inputKey.endsWith(`.${extension}`)).toBe(true);
    const queued = await queues[0]!.getJob(job.id);
    expect(queued?.data?.input?.contentType).toBe(type);
  });

  it("un video sigue siendo video", async () => {
    const response = await upload("clase.mp4", "video/mp4");
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; mediaKind: string };
    created.push(job.id);
    expect(job.mediaKind).toBe("video");
  });

  it("el tipo se ve igual al consultar el trabajo y en la lista", async () => {
    const { id } = (await (await upload("charla.mp3", "audio/mpeg")).json()) as { id: string };
    created.push(id);
    expect(((await (await fetch(`${base}/v1/jobs/${id}`)).json()) as { mediaKind: string }).mediaKind).toBe("audio");
    const list = (await (await fetch(`${base}/v1/jobs?limit=100`)).json()) as { jobs: Array<{ id: string; mediaKind: string }> };
    expect(list.jobs.find((job) => job.id === id)?.mediaKind).toBe("audio");
  });

  it("415 con un audio que no está en la lista (AAC suelto, WebM de audio) y con lo que no es multimedia", async () => {
    for (const [name, type] of [["nota.aac", "audio/aac"], ["voz.weba", "audio/webm"], ["texto.txt", "text/plain"], ["x.bin", "application/octet-stream"]] as const) {
      const response = await upload(name, type);
      expect(response.status, type).toBe(415);
    }
  });
});

describe("quemar subtítulos sobre un audio", () => {
  it("400 burn_not_available_for_audio ANTES de crear o encolar nada", async () => {
    const parent = await completedTranscription("podcast.mp3", "audio/mpeg");
    const before = await prisma.job.count({ where: { tenantId, kind: "BURN" } });
    const response = await post(`${base}/v1/jobs/${parent}/burn`, { style: "modern" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "burn_not_available_for_audio" });
    expect(await prisma.job.count({ where: { tenantId, kind: "BURN" } })).toBe(before);
  });

  it("con un video el quemado sigue funcionando", async () => {
    const parent = await completedTranscription("clase.mp4", "video/mp4");
    const response = await post(`${base}/v1/jobs/${parent}/burn`, { style: "modern" });
    expect(response.status).toBe(202);
    created.push(((await response.json()) as { id: string }).id);
  });
});

describe("doblar un audio", () => {
  it.each(["duck", "replace"])("400 mix_not_available_for_audio con mezcla %s, sin crear ni encolar nada", async (mix) => {
    const parent = await completedTranscription("podcast.mp3", "audio/mpeg");
    const before = await prisma.job.count({ where: { tenantId, kind: "DUB" } });
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", mix });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "mix_not_available_for_audio" });
    expect(await prisma.job.count({ where: { tenantId, kind: "DUB" } })).toBe(before);
  });

  it("sin mezcla (o con none) se dobla, y el resultado será la pista .mp3", async () => {
    for (const body of [{ provider: "openai", voice: "alloy" }, { provider: "openai", voice: "alloy", mix: "none" }]) {
      const parent = await completedTranscription("voz.wav", "audio/wav");
      const response = await post(`${base}/v1/jobs/${parent}/dub`, body);
      expect(response.status).toBe(202);
      const job = (await response.json()) as { id: string; kind: string; mediaKind: string };
      created.push(job.id);
      expect(job).toMatchObject({ kind: "DUB", mediaKind: "audio" });
    }
  });

  it("con un video la mezcla duck sigue admitida", async () => {
    const parent = await completedTranscription("clase.mp4", "video/mp4");
    const response = await post(`${base}/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", mix: "duck" });
    expect(response.status).toBe(202);
    created.push(((await response.json()) as { id: string }).id);
  });
});
