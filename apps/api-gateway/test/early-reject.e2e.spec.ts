// Un rechazo temprano (413, 429, 403, 421...) llega mientras el cliente sigue enviando el cuerpo. Si el servidor no lo
// lee, el navegador se queda enviando contra una conexión atascada y NUNCA llega a ver el error (XMLHttpRequest no
// entrega la respuesta hasta terminar de subir). Y cerrar de golpe tampoco sirve: el cliente recibe un reinicio de la
// conexión y pierde la respuesta. Por eso el servidor descarta un trozo acotado del cuerpo restante y entonces corta
// (main.ts: discardRemainingBody). Estas pruebas usan un socket TCP crudo con contrapresión, como un navegador: el
// cliente http de Node deja de enviar en cuanto recibe una respuesta completa y no reproduce el problema.
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { DISCARD_LIMIT_BYTES, DISCARD_TIMEOUT_MS, createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { disposeTestTenants, sharedTenant, type TestTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const token = `early-${randomUUID().slice(0, 8)}`;
let prisma: PrismaService | undefined;
let tenant: TestTenant;

async function start(overrides: { maxUploadBytes?: number; uploadRateLimitPerMinute?: number } = {}): Promise<number> {
  tenant = await sharedTenant();
  const app = await createApp(
    {
      ...baseConfig,
      maxUploadBytes: overrides.maxUploadBytes ?? 1024 * 1024,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      security: {
        webApiKey: undefined,
        rateLimitPerMinute: 0,
        uploadRateLimitPerMinute: overrides.uploadRateLimitPerMinute ?? 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0,
        trustProxy: false,
        maxConcurrentUploads: 0,
        maxConcurrentUploadsPerClient: 0,
        uploadMinBytesPerSecond: 0,
        uploadRateWindowMs: 30_000,
        maxEventStreams: 0,
        maxEventStreamsPerClient: 0,
        eventStreamMaxMs: 0,
        allowedOrigins: [],
        allowedHosts: ["127.0.0.1"],
      },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  prisma = app.get(PrismaService);
  return Number(new URL(await app.getUrl()).port);
}

afterAll(async () => {
  await prisma?.job.deleteMany({ where: { originalFilename: { contains: token } } }).catch(() => undefined);
  for (const app of apps) await app.close();
});

const BOUNDARY = "XXBOUNDARY";
const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${token}.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
const CHUNK = 64 * 1024;

type Outcome = {
  status: number | undefined;
  retryAfter: string | undefined;
  finishedSending: boolean;
  endedAfterMs: number;
  deliveredBytes: number;
};

/** Sigue enviando `totalBytes` aunque el servidor ya haya respondido, como un navegador. */
function upload(port: number, totalBytes: number, headers: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(port, "127.0.0.1");
    let status: number | undefined;
    let retryAfter: string | undefined;
    let received = "";
    let finishedSending = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      resolve({ status, retryAfter, finishedSending, endedAfterMs: Date.now() - started, deliveredBytes: socket.bytesWritten });
      socket.destroy();
    };
    const giveUp = setTimeout(settle, DISCARD_TIMEOUT_MS + 15_000);
    socket.on("data", (data) => {
      received += data.toString("latin1");
      status ??= Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1]) || undefined;
      retryAfter ??= /\r\nretry-after: *([^\r\n]+)/i.exec(received)?.[1];
    });
    socket.on("error", settle);
    socket.on("close", settle);

    const requestHead = [
      "POST /v1/jobs/transcribe HTTP/1.1",
      `Host: ${headers.host ?? "127.0.0.1"}`,
      `X-API-Key: ${tenant.apiKey}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
      "Transfer-Encoding: chunked",
      "",
      "",
    ].join("\r\n");
    const chunk = (data: Buffer) => Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]);
    const write = (data: Buffer) => (socket.destroyed ? true : socket.write(data));

    void (async () => {
      write(Buffer.from(requestHead));
      write(chunk(head));
      let queued = 0;
      while (queued < totalBytes && !socket.destroyed) {
        queued += CHUNK;
        if (!write(chunk(randomBytes(CHUNK)))) await new Promise<void>((next) => socket.once("drain", next).once("close", next));
      }
      if (!socket.destroyed) {
        write(chunk(tail));
        write(Buffer.from("0\r\n\r\n"));
        finishedSending = true;
        // El servidor puede dejar la conexión abierta (keep-alive): basta con haber enviado todo y visto la respuesta
        // (un 202 llega después de guardar el archivo en S3, así que se espera a que aparezca).
        const wait = setInterval(() => {
          if (status === undefined && !settled) return;
          clearInterval(wait);
          setTimeout(settle, 100);
        }, 50);
        socket.once("close", () => clearInterval(wait));
      }
    })();
  });
}

describe("rechazo temprano de una subida (413)", () => {
  it("un cuerpo moderado se descarta entero: el cliente termina de enviar y ve el 413 limpio", async () => {
    const port = await start();
    const outcome = await upload(port, 3 * 1024 * 1024);
    expect(outcome.status).toBe(413);
    expect(outcome.finishedSending).toBe(true);
    expect(outcome.endedAfterMs).toBeLessThan(DISCARD_TIMEOUT_MS);
  }, 40_000);

  it("el descarte tiene tope de bytes: un cuerpo enorme se corta al pasarse del límite", async () => {
    const port = await start();
    const total = DISCARD_LIMIT_BYTES * 4;
    const outcome = await upload(port, total);
    expect(outcome.status).toBe(413); // la respuesta llegó antes del corte
    expect(outcome.finishedSending).toBe(false);
    expect(outcome.deliveredBytes).toBeLessThan(total);
    expect(outcome.endedAfterMs).toBeLessThan(DISCARD_TIMEOUT_MS + 5_000);
  }, 60_000);
});

describe("rechazo temprano por límite de uso (429)", () => {
  it("la segunda subida recibe 429 con Retry-After y el cliente la ve aunque siga enviando un cuerpo grande", async () => {
    const port = await start({ uploadRateLimitPerMinute: 1, maxUploadBytes: 64 * 1024 * 1024 });
    const first = await upload(port, 32 * 1024);
    expect(first.status).toBe(202);

    const second = await upload(port, 3 * 1024 * 1024);
    expect(second.status).toBe(429);
    expect(Number(second.retryAfter)).toBeGreaterThan(0);
    expect(second.finishedSending).toBe(true);
  }, 40_000);
});

describe("rechazo temprano de la guardia (421)", () => {
  it("un Host no permitido responde 421 y la conexión termina aunque el cliente siga enviando", async () => {
    const port = await start();
    const outcome = await upload(port, 3 * 1024 * 1024, { host: "evil.example" });
    expect(outcome.status).toBe(421);
    expect(outcome.finishedSending).toBe(true);
    expect(outcome.endedAfterMs).toBeLessThan(DISCARD_TIMEOUT_MS);
  }, 40_000);
});
