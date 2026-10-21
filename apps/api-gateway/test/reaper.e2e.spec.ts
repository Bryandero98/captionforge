// Recolector de trabajos huérfanos contra PostgreSQL y Redis REALES.
import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { ReaperService } from "../src/jobs/reaper.service.js";
import { createApp } from "../src/main.js";
import { QUEUES } from "../src/queue/names.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

const config = { ...loadConfig(), reaper: { intervalMs: 0, staleRunningMs: 20 * 60_000, queuedGraceMs: 5 * 60_000 } };
const created: string[] = [];
const MINUTE = 60_000;

let app: Awaited<ReturnType<typeof createApp>>;
let prisma: PrismaService;
let reaper: ReaperService;
let queue: Queue;

/** Inserta una fila directamente (sin pasar por la subida) con las fechas indicadas. */
async function insertJob(opts: { status: "QUEUED" | "RUNNING" | "COMPLETED"; minutesSinceUpdate?: number; minutesSinceCreated?: number; kind?: "TRANSCRIBE" | "BURN" }): Promise<string> {
  const id = randomUUID();
  created.push(id);
  await prisma.job.create({
    data: {
      id,
      kind: opts.kind ?? "TRANSCRIBE",
      status: opts.status,
      inputBucket: config.s3.bucket,
      inputKey: `jobs/${id}/input.mp4`,
      originalFilename: "v.mp4",
      contentType: "video/mp4",
      sizeBytes: 1n,
      outputPrefix: `jobs/${id}/out/`,
      options: {},
    },
  });
  const updated = new Date(Date.now() - (opts.minutesSinceUpdate ?? 0) * MINUTE);
  const createdAt = new Date(Date.now() - (opts.minutesSinceCreated ?? opts.minutesSinceUpdate ?? 0) * MINUTE);
  await prisma.$executeRaw`UPDATE "Job" SET "updatedAt" = ${updated}, "createdAt" = ${createdAt} WHERE id = ${id}::uuid`;
  return id;
}

const row = (id: string) => prisma.job.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  app = await createApp(config, { logger: ["error"] });
  await app.init();
  prisma = app.get(PrismaService);
  reaper = app.get(ReaperService);
  queue = new Queue(QUEUES.transcribe, { connection: { host: config.redis.host, port: config.redis.port, password: config.redis.password } });
});

afterAll(async () => {
  for (const id of created) {
    await (await queue.getJob(id))?.remove().catch(() => undefined);
    await prisma.job.delete({ where: { id } }).catch(() => undefined);
  }
  await queue.close();
  await app.close();
});

describe("trabajos RUNNING sin respuesta", () => {
  it("cierra como FAILED el que lleva más de JOB_STALE_MINUTES sin cambios y respeta el resto", async () => {
    const dead = await insertJob({ status: "RUNNING", minutesSinceUpdate: 30 });
    const alive = await insertJob({ status: "RUNNING", minutesSinceUpdate: 2 });
    const finished = await insertJob({ status: "COMPLETED", minutesSinceUpdate: 90 });

    const outcome = await reaper.reapOnce();
    expect(outcome.stuckRunning).toBeGreaterThanOrEqual(1);

    expect(await row(dead)).toMatchObject({ status: "FAILED", errorCode: "INTERNAL" });
    expect((await row(dead)).finishedAt).not.toBeNull();
    expect((await row(dead)).errorMessage).toContain("dejó de responder");
    expect((await row(alive)).status).toBe("RUNNING");
    expect((await row(finished)).status).toBe("COMPLETED");
  });

  it("un latido del worker (progreso) lo salva: lo que cuenta es el último cambio, no cuándo empezó", async () => {
    const id = await insertJob({ status: "RUNNING", minutesSinceUpdate: 30 });
    await prisma.$executeRaw`UPDATE "Job" SET "updatedAt" = now() WHERE id = ${id}::uuid`; // el worker reportó progreso
    await reaper.reapOnce();
    expect((await row(id)).status).toBe("RUNNING");
  });

  it("avisa por Redis al worker del trabajo que cierra, por si solo estaba callado y sigue gastando CPU", async () => {
    const { Redis } = await import("ioredis");
    const subscriber = new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password });
    const received: string[] = [];
    subscriber.on("message", (_channel, message) => received.push((JSON.parse(message) as { jobId: string }).jobId));
    await subscriber.subscribe("captionforge:cancel");
    try {
      const id = await insertJob({ status: "RUNNING", minutesSinceUpdate: 40 });
      await reaper.reapOnce();
      await expect.poll(() => received.includes(id), { timeout: 3000 }).toBe(true);
    } finally {
      subscriber.disconnect();
    }
  });

  it("es idempotente: una segunda pasada no vuelve a tocar lo ya cerrado", async () => {
    const id = await insertJob({ status: "RUNNING", minutesSinceUpdate: 45 });
    await reaper.reapOnce();
    const first = await row(id);
    await reaper.reapOnce();
    expect((await row(id)).finishedAt).toEqual(first.finishedAt);
  });
});

describe("trabajos QUEUED perdidos", () => {
  it("cierra el que ya no está en Redis pasado el período de gracia", async () => {
    const lost = await insertJob({ status: "QUEUED", minutesSinceCreated: 10 });
    await reaper.reapOnce();
    expect(await row(lost)).toMatchObject({ status: "FAILED", errorCode: "INTERNAL" });
    expect((await row(lost)).errorMessage).toContain("se perdió de la cola");
  });

  it("respeta el que sí sigue en la cola, aunque sea viejo", async () => {
    const id = await insertJob({ status: "QUEUED", minutesSinceCreated: 10 });
    await queue.add("transcribe", { jobId: id }, { jobId: id });
    await reaper.reapOnce();
    expect((await row(id)).status).toBe("QUEUED");
  });

  it("respeta el recién creado aunque todavía no esté en Redis (período de gracia)", async () => {
    const id = await insertJob({ status: "QUEUED", minutesSinceCreated: 1 });
    await reaper.reapOnce();
    expect((await row(id)).status).toBe("QUEUED");
  });

  it("busca en la cola de su tipo: un quemado perdido se cierra aunque exista un id igual en la de transcripción", async () => {
    const id = await insertJob({ status: "QUEUED", kind: "BURN", minutesSinceCreated: 10 });
    await queue.add("transcribe", { jobId: id }, { jobId: id }); // mismo id, cola equivocada
    await reaper.reapOnce();
    expect((await row(id)).status).toBe("FAILED");
  });
});

describe("temporizador", () => {
  it("con REAPER_INTERVAL_SECONDS > 0 recolecta solo, y se detiene al cerrar la aplicación", async () => {
    const timed = await createApp({ ...config, reaper: { ...config.reaper, intervalMs: 100 } }, { logger: ["error"] });
    await timed.init();
    try {
      const id = await insertJob({ status: "RUNNING", minutesSinceUpdate: 60 });
      await expect.poll(async () => (await row(id)).status, { timeout: 5000, interval: 100 }).toBe("FAILED");
    } finally {
      await timed.close(); // si el temporizador no se limpiara, vitest dejaría el proceso colgado
    }
  });
});
