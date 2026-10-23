// Observabilidad (ADR 0018): registros JSON sin secretos, identificador de petición y /metrics en un puerto aparte.
import http from "node:http";
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/main.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { JsonLogger } from "../src/observability/json-logger.js";
import { startMetricsServer } from "../src/observability/metrics-server.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const lines: string[] = [];
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let metricsUrl: string;
let metricsServer: http.Server;
let tenant: TestTenant;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

const records = () => lines.flatMap((line) => line.split("\n").filter((part) => part !== "")).map((line) => JSON.parse(line) as Record<string, unknown>);
const requestRecords = () => records().filter((record) => record.event === "http_request");
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeAll(async () => {
  tenant = await createTestTenant("obs");
  const config: AppConfig = {
    ...baseConfig,
    reaper: { ...baseConfig.reaper, intervalMs: 0 },
    security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 1, tenantMaxQueuedJobs: 0 },
    observability: { ...baseConfig.observability, logFormat: "json", logRequests: true },
  };
  app = await createApp(config, { logger: new JsonLogger({ write: (text) => lines.push(text) }) });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  const port = await freePort();
  metricsServer = await startMetricsServer(app, { host: "127.0.0.1", port });
  metricsUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
  await app.close();
  await disposeTestTenants();
});

describe("registros JSON", () => {
  it("cada línea es JSON con hora, nivel, contexto y mensaje", () => {
    const sample = new JsonLogger({ write: (text) => lines.push(text) });
    sample.warn("algo pasó", "Prueba");
    const last = records().at(-1)!;
    expect(last).toMatchObject({ level: "warn", context: "Prueba", msg: "algo pasó" });
    expect(Number.isNaN(Date.parse(String(last.time)))).toBe(false);
  });

  it("una petición deja una línea con ruta (patrón), estado, duración, tenant e identificador, y /health no", async () => {
    lines.length = 0;
    await fetch(`${base}/health`);
    const response = await fetch(`${base}/v1/jobs`, { headers: tenant.headers });
    expect(response.status).toBe(200);
    await settle();
    const requests = requestRecords();
    expect(requests.some((record) => record.route === "/health")).toBe(false);
    const listed = requests.find((record) => record.route === "/v1/jobs");
    expect(listed).toMatchObject({ method: "GET", status: 200, tenantId: tenant.id });
    expect(typeof listed!.durationMs).toBe("number");
    expect(listed!.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("nunca registra claves, cookies, ni la cadena de consulta (códigos de OAuth)", async () => {
    lines.length = 0;
    await fetch(`${base}/auth/github/callback?code=CODIGO-SECRETO&state=ESTADO-SECRETO`, { headers: { cookie: "cf_session=COOKIE-SECRETA", "x-api-key": tenant.apiKey }, redirect: "manual" });
    await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`, { headers: { authorization: "Bearer BEARER-SECRETO", "x-api-key": tenant.apiKey } });
    await settle();
    const text = lines.join("");
    for (const secret of ["CODIGO-SECRETO", "ESTADO-SECRETO", "COOKIE-SECRETA", "BEARER-SECRETO", tenant.apiKey]) expect(text).not.toContain(secret);
    expect(requestRecords().length).toBeGreaterThanOrEqual(2);
  });

  it("respeta un X-Request-Id razonable y descarta uno peligroso o enorme", async () => {
    const good = await fetch(`${base}/health`, { headers: { "x-request-id": "caddy-1234-abcd" } });
    expect(good.headers.get("x-request-id")).toBe("caddy-1234-abcd");
    for (const bad of ["con espacio y \"comillas\"", "x".repeat(200)]) {
      const response = await fetch(`${base}/health`, { headers: { "x-request-id": bad } });
      const id = response.headers.get("x-request-id")!;
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("/metrics", () => {
  it("el puerto público NO sirve /metrics", async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });

  it("el puerto interno sirve el formato de Prometheus con peticiones, cuotas y trabajos, sin datos de personas", async () => {
    // Una subida permitida y una negada por cuota (tope de 1 por hora).
    const upload = () => {
      const data = new FormData();
      data.append("file", new File([new Uint8Array(512)], "obs.mp4", { type: "video/mp4" }));
      return fetch(`${base}/v1/jobs/transcribe`, { method: "POST", headers: tenant.headers, body: data });
    };
    expect((await upload()).status).toBe(202);
    expect((await upload()).status).toBe(429);
    await settle();

    const response = await fetch(`${metricsUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toMatch(/captionforge_http_requests_total\{[^}]*route="\/v1\/jobs\/transcribe"[^}]*status="429"[^}]*\} 1/);
    expect(body).toMatch(/captionforge_http_request_duration_seconds_bucket\{/);
    expect(body).toMatch(/captionforge_quota_denied_total\{reason="uploads"\} 1/);
    expect(body).toMatch(/captionforge_quota_redis_failures_total 0/);
    expect(body).toMatch(/captionforge_jobs\{status="QUEUED"\} \d+/);
    expect(body).toContain("process_cpu_user_seconds_total");
    // Cardinalidad acotada y privacidad: ni ids de tenant, ni claves, ni IP en las etiquetas.
    expect(body).not.toContain(tenant.id);
    expect(body).not.toContain(tenant.apiKey);
  }, 30_000);

  it("el servidor de métricas solo responde GET /metrics", async () => {
    expect((await fetch(`${metricsUrl}/otra`)).status).toBe(404);
    expect((await fetch(`${metricsUrl}/metrics`, { method: "POST" })).status).toBe(405);
  });
});
