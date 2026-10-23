// Topes de concurrencia (subidas y SSE) y consumo de memoria de las subidas, contra el API completo.
import { randomUUID } from "node:crypto";
import http from "node:http";

import { afterAll, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { JobsService } from "../src/jobs/jobs.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { UPLOAD_PART_BYTES, UPLOAD_QUEUE_SIZE } from "../src/storage/storage.service.js";
import { disposeTestTenants, sharedTenant, type TestTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const rows: { prisma: PrismaService; id: string }[] = [];
const open: { destroy: () => void }[] = [];
const MEMORY_BUDGET_MIB = Number(process.env.MEMORY_BUDGET_MIB ?? 200);
const uploaded: { prisma: PrismaService; id: string }[] = [];
let tenant: TestTenant;

/** Anota un trabajo creado por una subida de prueba para borrarlo (fila, cola y objeto de S3) al terminar. */
async function trackUpload(prisma: PrismaService, id: string): Promise<void> {
  uploaded.push({ prisma, id });
}

async function start(security: Partial<AppConfig["security"]>): Promise<{ base: string; prisma: PrismaService; jobs: JobsService }> {
  tenant = await sharedTenant();
  const app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      security: {
        webApiKey: undefined,
        rateLimitPerMinute: 0,
        uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0,
        trustProxy: false,
        maxConcurrentUploads: 0,
        maxConcurrentUploadsPerClient: 0,
        uploadMinBytesPerSecond: 0,
        uploadRateWindowMs: 30_000,
        maxEventStreams: 0,
        maxEventStreamsPerClient: 0,
        eventStreamMaxMs: 0,
        allowedOrigins: [],
        allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
        ...security,
      },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { base: await app.getUrl(), prisma: app.get(PrismaService), jobs: app.get(JobsService) };
}

afterAll(async () => {
  for (const connection of open) connection.destroy();
  for (const { prisma, id } of rows) await prisma.job.delete({ where: { id } }).catch(() => undefined);
  await cleanUploads();
  for (const app of apps) await app.close();
  await disposeTestTenants();
});

const BOUNDARY = "----limits-boundary";
const FILE_HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="v.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
const FILE_TAIL = `\r\n--${BOUNDARY}--\r\n`;

/** Abre una subida y la deja a medias (el cuerpo nunca termina) hasta que se llame a `finish` o `destroy`. */
function startStalledUpload(base: string): { status: Promise<number>; headers: Promise<http.IncomingHttpHeaders>; finish: () => void; destroy: () => void } {
  const url = new URL(`${base}/v1/jobs/transcribe`);
  let resolveStatus!: (code: number) => void;
  let resolveHeaders!: (headers: http.IncomingHttpHeaders) => void;
  const status = new Promise<number>((resolve) => (resolveStatus = resolve));
  const headers = new Promise<http.IncomingHttpHeaders>((resolve) => (resolveHeaders = resolve));
  const request = http.request(
    { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...tenant.headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "transfer-encoding": "chunked" } },
    (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
      resolveHeaders(response.headers);
    },
  );
  request.on("error", () => resolveStatus(0));
  request.write(FILE_HEAD);
  request.write(Buffer.alloc(64 * 1024, 1));
  const handle = {
    status,
    headers,
    finish: () => request.end(FILE_TAIL),
    destroy: () => request.destroy(),
  };
  open.push(handle);
  return handle;
}

async function insertQueuedJob(prisma: PrismaService): Promise<string> {
  const id = randomUUID();
  await prisma.job.create({
    data: {
      id,
      tenantId: tenant.id,
      kind: "TRANSCRIBE",
      status: "QUEUED",
      inputBucket: baseConfig.s3.bucket,
      inputKey: `jobs/${id}/input.mp4`,
      originalFilename: "v.mp4",
      contentType: "video/mp4",
      sizeBytes: 1n,
      outputPrefix: `jobs/${id}/out/`,
      options: {},
    },
  });
  rows.push({ prisma, id });
  return id;
}

async function cleanUploads(): Promise<void> {
  if (uploaded.length === 0) return;
  const { Queue } = await import("bullmq");
  const { QUEUES } = await import("../src/queue/names.js");
  const { StorageService } = await import("../src/storage/storage.service.js");
  const queue = new Queue(QUEUES.transcribe, { connection: { host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password } });
  const storage = new StorageService(baseConfig);
  try {
    for (const { prisma, id } of uploaded) {
      const row = await prisma.job.findUnique({ where: { id } });
      if (row) await storage.delete(row.inputKey).catch(() => undefined);
      await (await queue.getJob(id))?.remove().catch(() => undefined);
      await prisma.job.delete({ where: { id } }).catch(() => undefined);
    }
  } finally {
    await queue.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("subidas simultáneas (MAX_CONCURRENT_UPLOADS)", () => {
  it("la subida que pasa del tope recibe 503 con Retry-After, y el hueco vuelve cuando una termina o se corta", async () => {
    const { base } = await start({ maxConcurrentUploads: 2 });
    const first = startStalledUpload(base);
    const second = startStalledUpload(base);
    await sleep(300); // que ambas lleguen al servidor y ocupen su hueco

    const third = startStalledUpload(base);
    expect(await third.status).toBe(503);
    expect((await third.headers)["retry-after"]).toBeDefined();

    first.destroy(); // el cliente corta: el hueco se libera
    await sleep(500);
    const fourth = startStalledUpload(base);
    fourth.finish();
    expect(await fourth.status).toBe(202);

    second.destroy();
  });

  it("por cliente: una sola dirección no puede quedarse con todas las plazas (429)", async () => {
    const { base } = await start({ maxConcurrentUploads: 4, maxConcurrentUploadsPerClient: 1 });
    const first = startStalledUpload(base);
    await sleep(300);
    const second = startStalledUpload(base);
    expect(await second.status).toBe(429);
    expect((await second.headers)["retry-after"]).toBeDefined();
    first.destroy();
  });

  it("una subida que casi no avanza se corta con 408 y devuelve su plaza (anti-goteo)", async () => {
    const { base } = await start({ maxConcurrentUploads: 1, uploadMinBytesPerSecond: 1024, uploadRateWindowMs: 300 });
    const slow = startStalledUpload(base); // 64 KiB al empezar y después nada
    expect(await slow.status).toBe(408);
    const next = startStalledUpload(base);
    next.finish();
    expect(await next.status).toBe(202);
  });

  it("sin tope (0) no limita", async () => {
    const { base } = await start({ maxConcurrentUploads: 0 });
    const uploads = [startStalledUpload(base), startStalledUpload(base), startStalledUpload(base)];
    await sleep(300);
    for (const upload of uploads) upload.finish();
    expect(await Promise.all(uploads.map((u) => u.status))).toEqual([202, 202, 202]);
  });
});

describe("conexiones SSE (MAX_EVENT_STREAMS_*)", () => {
  it("por cliente: la que pasa del tope recibe 429 y el hueco vuelve al cerrar una", async () => {
    const { base, prisma } = await start({ maxEventStreamsPerClient: 2 });
    const id = await insertQueuedJob(prisma);
    const controllers = [new AbortController(), new AbortController()];
    for (const controller of controllers) {
      const response = await fetch(`${base}/v1/jobs/${id}/events`, { signal: controller.signal });
      expect(response.status).toBe(200);
    }
    const rejected = await fetch(`${base}/v1/jobs/${id}/events`);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).not.toBeNull();

    controllers[0]!.abort();
    await sleep(300);
    const retry = new AbortController();
    expect((await fetch(`${base}/v1/jobs/${id}/events`, { signal: retry.signal })).status).toBe(200);
    retry.abort();
    controllers[1]!.abort();
  });

  it("si el cliente corta mientras el servidor consulta el trabajo, el hueco se libera igual", async () => {
    const { base, prisma, jobs } = await start({ maxEventStreamsPerClient: 1 });
    const id = await insertQueuedJob(prisma);
    const original = jobs.get.bind(jobs);
    let slow = true;
    const spy = vi.spyOn(jobs, "get").mockImplementation(async (tenantId: string, jobId: string) => {
      if (slow) await sleep(500);
      return original(tenantId, jobId);
    });
    try {
      const url = new URL(`${base}/v1/jobs/${id}/events`);
      const request = http.get({ host: url.hostname, port: url.port, path: url.pathname, headers: tenant.headers });
      request.on("error", () => undefined);
      await sleep(100);
      request.destroy(); // corta mientras `jobs.get` sigue esperando
      await sleep(900);
      slow = false;
      const controller = new AbortController();
      const retry = await fetch(`${base}/v1/jobs/${id}/events`, { signal: controller.signal });
      expect(retry.status, "el hueco del cliente que cortó seguía ocupado").toBe(200);
      controller.abort();
    } finally {
      spy.mockRestore();
    }
  });

  it("con TRUST_PROXY=<red del proxy> el cliente es la última entrada no confiable: rotar la primera no esquiva el tope", async () => {
    const { base, prisma } = await start({ maxEventStreamsPerClient: 1, trustProxy: ["127.0.0.1"] });
    const id = await insertQueuedJob(prisma);
    const open = new AbortController();
    const headers = (forwarded: string) => ({ "x-forwarded-for": forwarded });
    expect((await fetch(`${base}/v1/jobs/${id}/events`, { headers: headers("7.7.7.7, 5.5.5.5"), signal: open.signal })).status).toBe(200);
    // El cliente inventa otra primera entrada, pero el proxy de confianza sigue viendo 5.5.5.5.
    expect((await fetch(`${base}/v1/jobs/${id}/events`, { headers: headers("8.8.8.8, 5.5.5.5") })).status).toBe(429);
    // Otro cliente real (otra última entrada) tiene su propio cupo.
    const other = new AbortController();
    expect((await fetch(`${base}/v1/jobs/${id}/events`, { headers: headers("1.1.1.1, 6.6.6.6"), signal: other.signal })).status).toBe(200);
    open.abort();
    other.abort();
  });

  it("global: pasado MAX_EVENT_STREAMS responde 503", async () => {
    const { base, prisma } = await start({ maxEventStreams: 2 });
    const id = await insertQueuedJob(prisma);
    const controllers = [new AbortController(), new AbortController()];
    for (const controller of controllers) expect((await fetch(`${base}/v1/jobs/${id}/events`, { signal: controller.signal })).status).toBe(200);
    expect((await fetch(`${base}/v1/jobs/${id}/events`)).status).toBe(503);
    for (const controller of controllers) controller.abort();
  });

  it("una petición que falla (trabajo inexistente) no se queda con el hueco", async () => {
    const { base, prisma } = await start({ maxEventStreamsPerClient: 1 });
    for (let i = 0; i < 3; i++) expect((await fetch(`${base}/v1/jobs/${randomUUID()}/events`)).status).toBe(404);
    const id = await insertQueuedJob(prisma);
    const controller = new AbortController();
    expect((await fetch(`${base}/v1/jobs/${id}/events`, { signal: controller.signal })).status).toBe(200);
    controller.abort();
  });

  it("duración máxima: el servidor cierra el flujo y libera el hueco (el cliente SSE reconecta solo)", async () => {
    const { base, prisma } = await start({ maxEventStreamsPerClient: 1, eventStreamMaxMs: 400 });
    const id = await insertQueuedJob(prisma);
    const response = await fetch(`${base}/v1/jobs/${id}/events`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const deadline = Date.now() + 4000;
    let closed = false;
    while (Date.now() < deadline) {
      const { done } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
    }
    expect(closed, "el flujo debía cerrarse solo al pasar la duración máxima").toBe(true);
    const next = new AbortController();
    expect((await fetch(`${base}/v1/jobs/${id}/events`, { signal: next.signal })).status).toBe(200);
    next.abort();
  });
});

/** Sube `mib` MiB de relleno por multipart, con contrapresión, y devuelve el estado y el id del trabajo creado. */
function uploadFiller(base: string, mib: number): Promise<{ status: number; id?: string }> {
  const url = new URL(`${base}/v1/jobs/transcribe`);
  const total = mib * 1024 * 1024;
  const chunk = Buffer.alloc(1024 * 1024, 7);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...tenant.headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "transfer-encoding": "chunked" } },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          let id: string | undefined;
          try {
            id = (JSON.parse(Buffer.concat(parts).toString()) as { id?: string }).id;
          } catch {
            /* respuesta sin JSON */
          }
          resolve({ status: response.statusCode ?? 0, id });
        });
      },
    );
    request.on("error", reject);
    request.write(FILE_HEAD);
    let sent = 0;
    const pump = (): void => {
      while (sent < total) {
        sent += chunk.length;
        if (!request.write(chunk)) {
          request.once("drain", pump);
          return;
        }
      }
      request.end(FILE_TAIL);
    };
    pump();
  });
}

/** Mide el pico de RSS mientras corre `work`. El servidor y el cliente de la prueba comparten proceso. */
async function peakRssGrowthMiB(work: () => Promise<unknown>): Promise<number> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 10);
  try {
    await work();
  } finally {
    clearInterval(sampler);
  }
  return (peak - baseline) / 1024 / 1024;
}

describe("memoria de las subidas (H2)", () => {
  it("la memoria que retiene una subida está acotada por configuración (~15 MiB) y las partes caben en el límite de S3", () => {
    const heldMiB = ((UPLOAD_QUEUE_SIZE + 1) * UPLOAD_PART_BYTES) / 1024 / 1024;
    expect(heldMiB).toBeLessThanOrEqual(16);
    expect(UPLOAD_PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024); // mínimo de una parte en S3
    expect(Math.ceil(baseConfig.maxUploadBytes / UPLOAD_PART_BYTES)).toBeLessThanOrEqual(10_000); // máximo de partes en S3
  });

  it("cuatro subidas concurrentes de 64 MiB: el pico no acumula los archivos (detector de retención, no medida fina)", { timeout: 120_000 }, async () => {
    const { base, prisma } = await start({ maxConcurrentUploads: 4 });
    const warm = await uploadFiller(base, 4); // arranque del cliente S3, JIT y reserva de memoria: coste fijo, no por subida
    if (warm.id) await trackUpload(prisma, warm.id);

    const growth = await peakRssGrowthMiB(async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() => uploadFiller(base, 64)));
      for (const result of results) {
        expect(result.status).toBe(202);
        if (result.id) await trackUpload(prisma, result.id);
      }
    });
    // Medido tras calentar: ~104-115 MiB (con la configuración anterior, cola 3 y partes de 8 MiB, 133-178). El RSS
    // incluye basura aún sin recolectar y el cliente de la prueba, así que esto solo detecta que se acumulen los
    // archivos (256 MiB); el límite fino por subida lo fija la prueba determinista de arriba.
    expect(growth, `RSS creció ${growth.toFixed(1)} MiB con 4 subidas concurrentes de 64 MiB`).toBeLessThan(MEMORY_BUDGET_MIB);
  });
});
