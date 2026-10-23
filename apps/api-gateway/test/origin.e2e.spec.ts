// CSRF, CORS y DNS rebinding (H10) contra el API completo: PostgreSQL, Redis y S3 reales.
import { randomUUID } from "node:crypto";
import http from "node:http";

import { afterAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { JobsService } from "../src/jobs/jobs.service.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { disposeTestTenants, sharedTenant, type TestTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const WEB = "http://localhost:5173";
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const rows: { prisma: PrismaService; id: string }[] = [];
let tenant: TestTenant;

async function start(security: Record<string, unknown> = {}): Promise<{ port: number; jobs: JobsService; prisma: PrismaService }> {
  tenant = await sharedTenant();
  const app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      security: {
        webApiKey: undefined,
        rateLimitPerMinute: 0,
        uploadRateLimitPerMinute: 0,
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
  return { port: Number(new URL(await app.getUrl()).port), jobs: app.get(JobsService), prisma: app.get(PrismaService) };
}

afterAll(async () => {
  for (const { prisma, id } of rows) await prisma.job.delete({ where: { id } }).catch(() => undefined);
  for (const app of apps) await app.close();
  await disposeTestTenants();
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** http.request y no fetch: fetch no permite fijar Host ni Origin a voluntad. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers: { ...tenant.headers, ...headers } }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(parts).toString() }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const BOUNDARY = "----origin-boundary";
const multipart = (): { headers: Record<string, string>; body: Buffer } => {
  const body = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="v.mp4"\r\nContent-Type: video/mp4\r\n\r\nxxxx\r\n--${BOUNDARY}--\r\n`,
  );
  return { headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length) }, body };
};

describe("CSRF: un POST de otra página no llega a crear trabajos", () => {
  it("POST multipart (petición simple, sin preflight) con Origin ajeno: 403 y no se crea nada", async () => {
    const { port, jobs } = await start();
    const created = vi.spyOn(jobs, "createTranscription");
    const { headers, body } = multipart();
    const reply = await send(port, "POST", "/v1/jobs/transcribe", { ...headers, origin: "http://evil.example" }, body);
    expect(reply.status).toBe(403);
    expect(created).not.toHaveBeenCalled();
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("cancelar, editar y quemar desde un Origin ajeno también se rechazan", async () => {
    const { port } = await start();
    const id = randomUUID();
    for (const [method, path] of [
      ["POST", `/v1/jobs/${id}/cancel`],
      ["PUT", `/v1/jobs/${id}/segments`],
      ["POST", `/v1/jobs/${id}/burn`],
    ] as const) {
      const reply = await send(port, method, path, { origin: "http://evil.example" });
      expect(reply.status, `${method} ${path}`).toBe(403);
    }
  });

  it("Origin: null (iframe con sandbox, archivo local) se rechaza", async () => {
    const { port } = await start();
    expect((await send(port, "POST", "/v1/jobs/transcribe", { origin: "null" })).status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site sin Origin en un POST se rechaza; en un GET no", async () => {
    const { port } = await start();
    expect((await send(port, "POST", "/v1/jobs/transcribe", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send(port, "GET", `/v1/jobs/${randomUUID()}`, { "sec-fetch-site": "cross-site" })).status).toBe(404);
  });

  it("un cliente sin Origin (curl, otro servicio) sigue funcionando: llega al handler", async () => {
    const { port } = await start();
    const reply = await send(port, "POST", "/v1/jobs/transcribe", { "content-type": "application/json" }, Buffer.from("{}"));
    expect(reply.status).toBe(415); // "Se esperaba multipart/form-data": pasó la guardia
  });

  it("el mismo origen pasa (la interfaz servida por el propio API)", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", `/v1/jobs/${randomUUID()}`, { origin: `http://127.0.0.1:${port}` });
    expect(reply.status).toBe(404);
  });
});

describe("respuestas de la guardia", () => {
  it("el 403 y el 421 llevan un cuerpo de error fijo (el manejo de un cuerpo sin leer está en early-reject.e2e.spec.ts)", async () => {
    const { port } = await start();
    const forbidden = await send(port, "POST", "/v1/jobs/transcribe", { origin: "http://evil.example" });
    const misdirected = await send(port, "GET", `/v1/jobs/${randomUUID()}`, { host: "evil.example" });
    expect(misdirected.status).toBe(421);
    expect(JSON.parse(forbidden.body)).toEqual({ statusCode: 403, message: "Origen no permitido.", error: "Forbidden" });
  });

  it("el mensaje de error no refleja el Host ni el Origin recibidos", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", `/v1/jobs/${randomUUID()}`, { host: "<script>alert(1)</script>.example" });
    expect(reply.body).not.toContain("script");
  });
});

describe("/health y el navegador", () => {
  it("un sondeo (sin Origin ni Sec-Fetch-Site) responde con cualquier Host", async () => {
    const { port } = await start();
    expect((await send(port, "GET", "/health", { host: "10.9.8.7:3000" })).status).toBe(200);
  });

  it("<img src=/health> desde otra página (Sec-Fetch-Site: cross-site) o con Origin ajeno se rechaza antes de tocar la base de datos", async () => {
    const { port, prisma } = await start();
    const query = vi.spyOn(prisma, "$queryRaw");
    expect((await send(port, "GET", "/health", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send(port, "GET", "/health", { origin: "http://evil.example" })).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("el cliente web autorizado puede consultarlo con CORS", async () => {
    const { port } = await start({ allowedOrigins: [WEB] });
    const reply = await send(port, "GET", "/health", { origin: WEB });
    expect(reply.status).toBe(200);
    expect(reply.headers["access-control-allow-origin"]).toBe(WEB);
  });
});

describe("DNS rebinding: Host ajeno", () => {
  it("421 con un Host que no está en ALLOWED_HOSTS, también con lecturas", async () => {
    const { port } = await start();
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1.evil.example"]) {
      const reply = await send(port, "GET", `/v1/jobs/${randomUUID()}`, { host });
      expect(reply.status, host).toBe(421);
    }
  });

  it("/health responde con cualquier Host (sondeos del orquestador)", async () => {
    const { port } = await start();
    expect((await send(port, "GET", "/health", { host: "10.1.2.3:3000" })).status).toBe(200);
  });

  it("ALLOWED_HOSTS añade nombres propios, sin puerto", async () => {
    const { port } = await start({ allowedHosts: ["localhost", "api.captionforge.local"] });
    expect((await send(port, "GET", `/v1/jobs/${randomUUID()}`, { host: "api.captionforge.local:8443" })).status).toBe(404);
    expect((await send(port, "GET", `/v1/jobs/${randomUUID()}`, { host: "127.0.0.1" })).status).toBe(421);
  });
});

describe("CORS con lista cerrada de orígenes", () => {
  it("sin ALLOWED_ORIGINS no se emite ninguna cabecera CORS", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", `/v1/jobs/${randomUUID()}`);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("el preflight de un origen permitido responde 204 con métodos y cabeceras exactos, sin credenciales", async () => {
    const { port } = await start({ allowedOrigins: [WEB] });
    const reply = await send(port, "OPTIONS", "/v1/jobs/transcribe", {
      origin: WEB,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-api-key",
    });
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-origin"]).toBe(WEB);
    expect(reply.headers["access-control-allow-methods"]).toBe("GET, HEAD, POST, PUT, DELETE, OPTIONS");
    expect(reply.headers["access-control-allow-headers"]).toMatch(/x-api-key/i);
    expect(reply.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(reply.headers["access-control-max-age"]).toBeDefined();
    expect(reply.headers.vary).toMatch(/origin/i);
  });

  it("el preflight de otro origen se rechaza (403) y no lleva cabeceras CORS", async () => {
    const { port } = await start({ allowedOrigins: [WEB] });
    const reply = await send(port, "OPTIONS", "/v1/jobs/transcribe", { origin: "http://evil.example", "access-control-request-method": "POST" });
    expect(reply.status).toBe(403);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("la respuesta real a un origen permitido expone ETag, Content-Range y Content-Disposition", async () => {
    const { port } = await start({ allowedOrigins: [WEB] });
    const reply = await send(port, "GET", `/v1/jobs/${randomUUID()}`, { origin: WEB });
    expect(reply.status).toBe(404);
    expect(reply.headers["access-control-allow-origin"]).toBe(WEB);
    expect(reply.headers["access-control-expose-headers"]).toMatch(/etag/i);
    expect(reply.headers["access-control-expose-headers"]).toMatch(/content-range/i);
    expect(reply.headers["access-control-expose-headers"]).toMatch(/content-disposition/i);
  });

  it("el flujo SSE también lleva la cabecera CORS del origen permitido", async () => {
    const { port, prisma } = await start({ allowedOrigins: [WEB] });
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
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port, path: `/v1/jobs/${id}/events`, headers: { ...tenant.headers, origin: WEB } }, (response) => {
        resolve(response.headers);
        request.destroy();
      });
      request.on("error", (error) => ((error as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(error)));
    });
    expect(headers["access-control-allow-origin"]).toBe(WEB);
  });
});

describe("cabeceras de seguridad", () => {
  it("nosniff, sin referrer y sin caché en las respuestas del API", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", `/v1/jobs/${randomUUID()}`);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
    expect(reply.headers["cache-control"]).toBe("no-store");
  });
});
