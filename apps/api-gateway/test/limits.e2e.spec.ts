// Topes de concurrencia (subidas y SSE) y consumo de memoria de las subidas, contra el API completo.
import { randomUUID } from "node:crypto";
import http from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const rows: { prisma: PrismaService; id: string }[] = [];
const open: { destroy: () => void }[] = [];

async function start(security: Partial<AppConfig["security"]>): Promise<{ base: string; prisma: PrismaService }> {
  const app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      security: {
        apiKey: undefined,
        rateLimitPerMinute: 0,
        uploadRateLimitPerMinute: 0,
        trustProxy: false,
        maxConcurrentUploads: 0,
        maxEventStreams: 0,
        maxEventStreamsPerClient: 0,
        eventStreamMaxMs: 0,
        ...security,
      },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { base: await app.getUrl(), prisma: app.get(PrismaService) };
}

afterAll(async () => {
  for (const connection of open) connection.destroy();
  for (const { prisma, id } of rows) await prisma.job.delete({ where: { id } }).catch(() => undefined);
  for (const app of apps) await app.close();
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
    { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "transfer-encoding": "chunked" } },
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

describe("memoria de las subidas (H2)", () => {
  it("subir 192 MiB no retiene el archivo: el pico es un sobrecoste fijo, menor que el archivo", async () => {
    const { base } = await start({ maxConcurrentUploads: 4 });
    const url = new URL(`${base}/v1/jobs/transcribe`);
    const total = 192 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    global.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "transfer-encoding": "chunked" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
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
    }).finally(() => clearInterval(sampler));

    expect(status).toBe(202);
    const growthMiB = (peak - baseline) / 1024 / 1024;
    // Medido: ~80-92 MiB con 48, 96 o 192 MiB (no crece con el tamaño). Si el archivo se acumulara serían >192.
    console.log(`crecimiento de RSS durante la subida de 192 MiB: ${growthMiB.toFixed(1)} MiB`);
    expect(growthMiB).toBeLessThan(140);
  });
});
