// Tenencia (ADR 0015) contra el API completo y la infraestructura REAL: autenticación por clave de API y, sobre todo,
// AISLAMIENTO: la clave de un tenant no puede listar, leer, editar, cancelar ni descargar nada de otro (404, no 403).
import { createHash } from "node:crypto";

import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { assertContract } from "../src/contracts/validators.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { QUEUES } from "../src/queue/names.js";
import { StorageService } from "../src/storage/storage.service.js";
import { LAST_USED_REFRESH_MS } from "../src/tenancy/tenant-auth.guard.js";
import { addApiKey, createTestTenant, disposeTestTenants, revokeApiKey, type TestTenant } from "./support/tenancy.js";
import { generateApiKey } from "../src/tenancy/api-key.js";

const config = loadConfig();
const connection = { host: config.redis.host, port: config.redis.port, password: config.redis.password };
const ABSENT = "00000000-0000-4000-8000-000000000000";
const created: string[] = [];
const keys: string[] = [];

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let prisma: PrismaService;
let storage: StorageService;
let transcribeQueue: Queue;
let burnQueue: Queue;
let worker: pg.Client; // hace de worker: escribe estado y resultado con el rol cf_worker
let owner: pg.Client; // para mirar la tabla ApiKey, que cf_api solo puede leer
let alice: TestTenant;
let bob: TestTenant;

const SEGMENTS = [
  { start: 0, end: 2, text: " Hola mundo", words: null },
  { start: 2, end: 4, text: " Segunda frase", words: null },
];

const as = (tenant: TestTenant, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...tenant.headers, ...(init.headers as Record<string, string> | undefined) } });
const call = (tenant: TestTenant, path: string, init: RequestInit = {}): Promise<Response> => fetch(`${base}${path}`, as(tenant, init));
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function form(): FormData {
  const data = new FormData();
  data.append("file", new File([new Uint8Array(2048).fill(7)], "entrevista.mp4", { type: "video/mp4" }));
  return data;
}

async function upload(tenant: TestTenant): Promise<string> {
  const response = await call(tenant, "/v1/jobs/transcribe", { method: "POST", body: form() });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  created.push(id);
  return id;
}

/** Una transcripción del tenant, terminada como lo haría el worker (con subtítulos y SRT en S3). */
async function completedTranscription(tenant: TestTenant): Promise<string> {
  const id = await upload(tenant);
  const segmentsKey = `jobs/${id}/out/segments.json`;
  const srtKey = `jobs/${id}/out/output.srt`;
  keys.push(segmentsKey, srtKey);
  const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(SEGMENTS)), "application/json");
  await storage.putBuffer(srtKey, Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nHola mundo\n"), "application/x-subrip");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 4,
    segmentCount: SEGMENTS.length,
    artifacts: { srt: srtKey, segments: { bucket: config.s3.bucket, objectKey: segmentsKey, etag }, waveform: `jobs/${id}/out/waveform.json` },
  };
  assertContract("transcribe-result.v1", result);
  await worker.query(
    `UPDATE "Job" SET status = 'COMPLETED', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [id, JSON.stringify(result)],
  );
  return id;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  app = await createApp(config, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  transcribeQueue = new Queue(QUEUES.transcribe, { connection });
  burnQueue = new Queue(QUEUES.burn, { connection });
  worker = new pg.Client({ connectionString: process.env.DATABASE_URL_WORKER });
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await Promise.all([worker.connect(), owner.connect()]);
  alice = await createTestTenant("alice");
  bob = await createTestTenant("bob");
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
  await Promise.all([worker.end(), owner.end()]);
  await transcribeQueue.close();
  await burnQueue.close();
  await app.close();
  await disposeTestTenants();
});

describe("autenticación por clave de API", () => {
  const url = () => `${base}/v1/jobs/${ABSENT}`;

  it("sin clave, con una clave desconocida o mal formada: 401 con WWW-Authenticate", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { "x-api-key": "otra-clave" },
      { "x-api-key": generateApiKey() }, // bien formada pero inexistente
      { authorization: "Bearer otra-clave" },
      { authorization: alice.apiKey }, // sin el esquema Bearer
      { authorization: `Basic ${alice.apiKey}` },
      { authorization: "Bearer " },
      { "x-api-key": "x".repeat(10_000) },
    ];
    for (const headers of attempts) {
      const response = await fetch(url(), { headers });
      expect(response.status, JSON.stringify(headers).slice(0, 80)).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("acepta X-API-Key y Authorization: Bearer", async () => {
    for (const headers of [{ "x-api-key": alice.apiKey }, { authorization: `Bearer ${alice.apiKey}` }, { authorization: `bearer ${alice.apiKey}` }] as Record<string, string>[]) {
      expect((await fetch(url(), { headers })).status).toBe(404); // pasó la guardia: el trabajo no existe
    }
  });

  it("protege TODAS las rutas de /v1, no solo las de lectura", async () => {
    const routes: [string, string][] = [
      ["GET", "/v1/jobs"],
      ["POST", "/v1/jobs/transcribe"],
      ["GET", `/v1/jobs/${ABSENT}`],
      ["POST", `/v1/jobs/${ABSENT}/cancel`],
      ["GET", `/v1/jobs/${ABSENT}/events`],
      ["GET", `/v1/jobs/${ABSENT}/segments`],
      ["PUT", `/v1/jobs/${ABSENT}/segments`],
      ["POST", `/v1/jobs/${ABSENT}/burn`],
      ["GET", `/v1/jobs/${ABSENT}/artifacts/srt`],
      ["HEAD", `/v1/jobs/${ABSENT}/artifacts/srt`],
    ];
    for (const [method, route] of routes) {
      expect((await fetch(`${base}${route}`, { method })).status, `${method} ${route}`).toBe(401);
    }
  });

  it("/health y /v1/capabilities no piden clave", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/capabilities`)).status).toBe(200);
  });

  it("la clave no se filtra en las respuestas de error", async () => {
    const response = await fetch(url(), { headers: { authorization: `Bearer ${alice.apiKey}-mal` } });
    expect(await response.text()).not.toContain(alice.apiKey);
  });

  it("la base guarda el SHA-256 de la clave y su prefijo, nunca la clave", async () => {
    const { rows } = await owner.query<{ keyHash: string; prefix: string }>(`SELECT "keyHash", prefix FROM "ApiKey" WHERE "tenantId" = $1`, [alice.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyHash).toBe(createHash("sha256").update(alice.apiKey).digest("hex"));
    expect(rows[0]!.prefix).toBe(alice.apiKey.slice(0, 8));
    expect(JSON.stringify(rows)).not.toContain(alice.apiKey);
  });

  it("una clave revocada deja de valer en la siguiente petición", async () => {
    const extra = generateApiKey();
    const id = await addApiKey(alice.id, extra);
    expect((await fetch(url(), { headers: { "x-api-key": extra } })).status).toBe(404);
    await revokeApiKey(id);
    expect((await fetch(url(), { headers: { "x-api-key": extra } })).status).toBe(401);
  });

  it("anota lastUsedAt sin retrasar la petición, y no reescribe antes de LAST_USED_REFRESH_MS", async () => {
    const fresh = generateApiKey();
    const id = await addApiKey(bob.id, fresh);
    const lastUsed = async (): Promise<Date | null> => (await owner.query<{ lastUsedAt: Date | null }>(`SELECT "lastUsedAt" FROM "ApiKey" WHERE id = $1`, [id])).rows[0]!.lastUsedAt;
    expect(await lastUsed()).toBeNull();

    expect((await fetch(url(), { headers: { "x-api-key": fresh } })).status).toBe(404);
    let first: Date | null = null;
    for (let i = 0; i < 40 && first === null; i++) {
      await sleep(50);
      first = await lastUsed();
    }
    expect(first).not.toBeNull();

    await fetch(url(), { headers: { "x-api-key": fresh } });
    await sleep(300);
    expect((await lastUsed())!.getTime()).toBe(first!.getTime()); // dentro del margen: no hubo otra escritura
    expect(LAST_USED_REFRESH_MS).toBeGreaterThan(1000);
  });
});

describe("aislamiento entre tenants: una clave no ve ni toca los trabajos de otro", () => {
  let queued: string; // de Alice, en cola
  let done: string; // de Alice, terminado

  beforeAll(async () => {
    queued = await upload(alice);
    done = await completedTranscription(alice);
  });

  it("Bob recibe 404 (no 403) al consultar un trabajo de Alice, igual que con un UUID que no existe", async () => {
    const foreign = await call(bob, `/v1/jobs/${queued}`);
    const absent = await call(bob, `/v1/jobs/${ABSENT}`);
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    // Indistinguible: ni el estado ni el cuerpo revelan que el UUID existe.
    expect(await foreign.json()).toEqual(await absent.json());
    expect((await call(alice, `/v1/jobs/${queued}`)).status).toBe(200);
  });

  it("Bob no puede cancelar el trabajo de Alice, y sigue en cola", async () => {
    const response = await call(bob, `/v1/jobs/${queued}/cancel`, { method: "POST" });
    expect(response.status).toBe(404);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: queued } })).status).toBe("QUEUED");
  });

  it("Bob no abre el flujo de eventos del trabajo de Alice", async () => {
    expect((await call(bob, `/v1/jobs/${queued}/events`)).status).toBe(404);
    const controller = new AbortController();
    const own = await call(alice, `/v1/jobs/${queued}/events`, { signal: controller.signal });
    expect(own.status).toBe(200);
    controller.abort();
  });

  it("Bob no lee ni edita los subtítulos de Alice", async () => {
    expect((await call(bob, `/v1/jobs/${done}/segments`)).status).toBe(404);
    const edit = await call(bob, `/v1/jobs/${done}/segments`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: [{ index: 0, text: "Hackeado" }] }) });
    expect(edit.status).toBe(404);

    const own = await call(alice, `/v1/jobs/${done}/segments`);
    expect(own.status).toBe(200);
    const { segments } = (await own.json()) as { segments: { text: string }[] };
    expect(segments[0]!.text).toBe(" Hola mundo"); // intacto
  });

  it("Bob no pide el quemado de la transcripción de Alice, y no se crea ningún trabajo", async () => {
    const before = await prisma.job.count({ where: { parentJobId: done } });
    expect((await call(bob, `/v1/jobs/${done}/burn`, json({}))).status).toBe(404);
    expect(await prisma.job.count({ where: { parentJobId: done } })).toBe(before);
  });

  it("Bob no descarga los artefactos de Alice (GET, HEAD ni con Range)", async () => {
    expect((await call(alice, `/v1/jobs/${done}/artifacts/srt`)).status).toBe(200);
    expect((await call(bob, `/v1/jobs/${done}/artifacts/srt`)).status).toBe(404);
    expect((await call(bob, `/v1/jobs/${done}/artifacts/srt`, { method: "HEAD" })).status).toBe(404);
    expect((await call(bob, `/v1/jobs/${done}/artifacts/segments`, { headers: { range: "bytes=0-5" } })).status).toBe(404);
  });

  it("el quemado de Alice pertenece a Alice, y Bob tampoco lo ve ni lo cancela", async () => {
    const response = await call(alice, `/v1/jobs/${done}/burn`, json({}));
    expect(response.status).toBe(202);
    const burn = (await response.json()) as { id: string };
    created.push(burn.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: burn.id } })).tenantId).toBe(alice.id);
    expect((await call(bob, `/v1/jobs/${burn.id}`)).status).toBe(404);
    expect((await call(bob, `/v1/jobs/${burn.id}/cancel`, { method: "POST" })).status).toBe(404);
  });

  it("Bob no lista los trabajos de Alice y Alice no lista los de Bob", async () => {
    const bobJob = await upload(bob);
    const ids = async (tenant: TestTenant): Promise<string[]> => ((await (await call(tenant, "/v1/jobs?limit=100")).json()) as { jobs: { id: string }[] }).jobs.map((job) => job.id);

    const forBob = await ids(bob);
    expect(forBob).toContain(bobJob);
    expect(forBob).not.toContain(queued);
    expect(forBob).not.toContain(done);

    const forAlice = await ids(alice);
    expect(forAlice).toEqual(expect.arrayContaining([queued, done]));
    expect(forAlice).not.toContain(bobJob);
  });

  it("un trabajo subido por Bob queda a nombre de Bob", async () => {
    const id = await upload(bob);
    expect((await prisma.job.findUniqueOrThrow({ where: { id } })).tenantId).toBe(bob.id);
  });

  it("la paginación respeta el tenant: el cursor de otro tenant da 404", async () => {
    const first = (await (await call(alice, "/v1/jobs?limit=1")).json()) as { jobs: { id: string }[]; nextCursor: string | null };
    expect(first.jobs).toHaveLength(1);
    expect(first.nextCursor).toBe(first.jobs[0]!.id);
    const second = (await (await call(alice, `/v1/jobs?limit=1&cursor=${first.nextCursor}`)).json()) as { jobs: { id: string }[] };
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]!.id).not.toBe(first.jobs[0]!.id);

    expect((await call(bob, `/v1/jobs?cursor=${queued}`)).status).toBe(404);
    expect((await call(alice, "/v1/jobs?limit=0")).status).toBe(400);
    expect((await call(alice, "/v1/jobs?limit=101")).status).toBe(400);
    expect((await call(alice, "/v1/jobs?cursor=no-es-uuid")).status).toBe(400);
  });

  it("ninguna ruta responde 403: un trabajo ajeno nunca se distingue de uno inexistente", async () => {
    const routes: [string, string][] = [
      ["GET", `/v1/jobs/${queued}`],
      ["POST", `/v1/jobs/${queued}/cancel`],
      ["GET", `/v1/jobs/${done}/segments`],
      ["POST", `/v1/jobs/${done}/burn`],
      ["GET", `/v1/jobs/${done}/artifacts/srt`],
    ];
    for (const [method, route] of routes) {
      const foreign = await call(bob, route, { method });
      const absent = await call(bob, route.replace(/[0-9a-f-]{36}/, ABSENT), { method });
      expect(foreign.status, `${method} ${route}`).toBe(absent.status);
      expect(foreign.status).not.toBe(403);
    }
  });
});
