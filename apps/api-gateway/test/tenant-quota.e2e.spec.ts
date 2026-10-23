// Cuotas por tenant en Redis (ADR 0017): subidas por hora y trabajos en cola. Contra PostgreSQL, Redis y S3 reales.
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/main.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { QUEUES } from "../src/queue/names.js";
import { TenantQuotaService } from "../src/quota/tenant-quota.service.js";
import { StorageService } from "../src/storage/storage.service.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const created: string[] = [];
let owner: pg.Client;
let queue: Queue;
let prisma: PrismaService;
let storage: StorageService;

const VIDEO = new Uint8Array(1024).fill(5);

/** API con las cuotas por tenant que pida cada prueba; los límites por IP se apagan para no mezclar causas. */
async function startApi(quota: Partial<AppConfig["security"]>): Promise<string> {
  const config: AppConfig = {
    ...baseConfig,
    reaper: { ...baseConfig.reaper, intervalMs: 0 },
    security: {
      ...baseConfig.security,
      webApiKey: undefined,
      rateLimitPerMinute: 0,
      uploadRateLimitPerMinute: 0,
      maxConcurrentUploads: 0,
      maxConcurrentUploadsPerClient: 0,
      tenantUploadsPerHour: 0,
      tenantMaxQueuedJobs: 0,
      ...quota,
    },
  };
  const app = await createApp(config, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  return app.getUrl();
}

async function upload(base: string, tenant: TestTenant): Promise<Response> {
  const data = new FormData();
  data.append("file", new File([VIDEO], "cuota.mp4", { type: "video/mp4" }));
  const response = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", headers: tenant.headers, body: data });
  if (response.status === 202) {
    const job = (await response.clone().json()) as { id: string };
    created.push(job.id);
  }
  return response;
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  queue = new Queue(QUEUES.transcribe, { connection: { host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password } });
});

afterAll(async () => {
  for (const id of created) {
    await (await queue.getJob(id))?.remove().catch(() => undefined);
    const job = await prisma?.job.findUnique({ where: { id } });
    if (job) await storage.delete(job.inputKey).catch(() => undefined);
  }
  await queue.close();
  for (const app of apps) await app.close();
  await disposeTestTenants();
  await owner.end();
});

describe("subidas por hora y por tenant", () => {
  it("al pasar el tope responde 429 con Retry-After, y otro tenant no se entera", async () => {
    const base = await startApi({ tenantUploadsPerHour: 2 });
    const ana = await createTestTenant("ana");
    const beto = await createTestTenant("beto");

    expect((await upload(base, ana)).status).toBe(202);
    expect((await upload(base, ana)).status).toBe(202);
    const denied = await upload(base, ana);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(denied.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
    expect(JSON.stringify(await denied.json())).toMatch(/subidas/i);

    expect((await upload(base, beto)).status).toBe(202);
  }, 30_000);

  it("0 desactiva el límite", async () => {
    const base = await startApi({ tenantUploadsPerHour: 0 });
    const tenant = await createTestTenant("libre");
    for (let i = 0; i < 4; i += 1) expect((await upload(base, tenant)).status).toBe(202);
  }, 30_000);

  it("el contador vive en Redis con vencimiento (no queda para siempre)", async () => {
    const base = await startApi({ tenantUploadsPerHour: 5 });
    const tenant = await createTestTenant("ttl");
    await upload(base, tenant);
    const { Redis } = await import("ioredis");
    const redis = new Redis({ host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password });
    try {
      const keys = await redis.keys(`captionforge:quota:${tenant.id}:*`);
      expect(keys).toHaveLength(1);
      const ttl = await redis.ttl(keys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3600);
    } finally {
      redis.disconnect();
    }
  }, 30_000);
});

describe("trabajos en cola por tenant", () => {
  it("con el tope de trabajos en curso lleno responde 429, y al terminar uno vuelve a aceptar", async () => {
    const base = await startApi({ tenantMaxQueuedJobs: 2 });
    const tenant = await createTestTenant("cola");

    expect((await upload(base, tenant)).status).toBe(202);
    expect((await upload(base, tenant)).status).toBe(202);
    const denied = await upload(base, tenant);
    expect(denied.status).toBe(429);
    expect(JSON.stringify(await denied.json())).toMatch(/cola|en curso/i);

    await owner.query(`UPDATE "Job" SET status = 'COMPLETED', "finishedAt" = now() WHERE id = $1`, [created[created.length - 1]]);
    expect((await upload(base, tenant)).status).toBe(202);
  }, 30_000);
});

describe("si Redis falla, el servicio sigue (fail-open)", () => {
  it("con el cliente de cuotas desconectado la subida pasa y el error queda en el registro", async () => {
    const base = await startApi({ tenantUploadsPerHour: 1 });
    const tenant = await createTestTenant("abierto");
    const quota = apps[apps.length - 1]!.get(TenantQuotaService);
    quota.simulateOutage(); // corta SOLO el cliente de cuotas: la cola de BullMQ sigue sana

    // Con Redis sano la segunda subida sería 429; con la cuota caída, la disponibilidad manda.
    expect((await upload(base, tenant)).status).toBe(202);
    expect((await upload(base, tenant)).status).toBe(202);
    expect(quota.failures).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
