// Canal interno de entrega de claves al worker (ADR 0020, T4): POST /internal/v1/jobs/:jobId/external-key en un puerto aparte.
// PostgreSQL, Redis y S3 reales (npm run infra:up).
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { ExternalKeyCipher } from "../src/external-keys/external-key-crypto.js";
import { startInternalServer } from "../src/internal/internal-server.js";
import { createApp } from "../src/main.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const APP_SECRET = "9f2c6a41d07b83e5a1c4f6d2b9087e53c1a4d6f8b20e7395a1c4d6f8e0b2a497";
const TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c";
const KEY_A = `sk-canario-A-${randomBytes(18).toString("hex")}`;
const KEY_B = `sk-canario-B-${randomBytes(18).toString("hex")}`;
const ELEVEN_B = `eleven-canario-B-${randomBytes(18).toString("hex")}`;

const baseConfig = loadConfig();
const cipher = new ExternalKeyCipher(APP_SECRET);
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const servers: import("node:http").Server[] = [];
let owner: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;
let internal: string; // http://127.0.0.1:<puerto interno> con APP_SECRET
let internalOff: string; // un API sin APP_SECRET
let publicBase: string; // el puerto público del mismo API

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

async function start(appSecret: string | undefined, rateLimitPerMinute = 10_000): Promise<{ publicUrl: string; internalUrl: string }> {
  const config = {
    ...baseConfig,
    reaper: { ...baseConfig.reaper, intervalMs: 0 },
    byok: { appSecret },
    security: { ...baseConfig.security, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0 },
  };
  const app = await createApp(config, { logger: ["error"] });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  const port = await freePort();
  servers.push(await startInternalServer(app, { host: "127.0.0.1", port, workerToken: TOKEN, rateLimitPerMinute }));
  return { publicUrl: await app.getUrl(), internalUrl: `http://127.0.0.1:${port}` };
}

async function insertKey(tenantId: string, provider: "openai" | "elevenlabs", key: string): Promise<void> {
  await owner.query(
    `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, $3::"ExternalProvider", $4, 1, $5)`,
    [randomUUID(), tenantId, provider, cipher.encrypt(key, { tenantId, provider, keyVersion: 1 }), key.slice(-4)],
  );
}

async function insertJob(tenantId: string, kind: string, status: string, options: unknown): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "Job" (id, "tenantId", kind, status, "inputBucket", "inputKey", "originalFilename", "contentType", "sizeBytes", "outputPrefix", options, "updatedAt")
     VALUES ($1, $2, $3::"JobKind", $4::"JobStatus", 'b', 'k', 'v.mp4', 'video/mp4', 1, $5, $6, now())`,
    [id, tenantId, kind, status, `jobs/${id}/out/`, JSON.stringify(options)],
  );
  return id;
}

const PATH = (jobId: string) => `/internal/v1/jobs/${jobId}/external-key`;

async function ask(base: string, jobId: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Response> {
  return fetch(`${base}${PATH(jobId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  tenantA = await createTestTenant("interno-a");
  tenantB = await createTestTenant("interno-b");
  await insertKey(tenantA.id, "openai", KEY_A);
  await insertKey(tenantB.id, "openai", KEY_B);
  await insertKey(tenantB.id, "elevenlabs", ELEVEN_B);
  const on = await start(APP_SECRET);
  internal = on.internalUrl;
  publicBase = on.publicUrl;
  internalOff = (await start(undefined)).internalUrl;
}, 60_000);

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const app of apps) await app.close();
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = ANY($1::uuid[])`, [[tenantA.id, tenantB.id]]);
  await disposeTestTenants();
  await owner.end();
});

describe("autenticación con WORKER_INTERNAL_TOKEN", () => {
  it.each<[string, () => Record<string, string>]>([
    ["sin Authorization", () => ({})],
    ["otro esquema", () => ({ authorization: `Basic ${TOKEN}` })],
    ["token equivocado", () => ({ authorization: `Bearer ${"0".repeat(64)}` })],
    ["token con un carácter de más", () => ({ authorization: `Bearer ${TOKEN}x` })],
    ["token truncado", () => ({ authorization: `Bearer ${TOKEN.slice(0, 40)}` })],
    ["Bearer vacío", () => ({ authorization: "Bearer " })],
    ["una clave de API de un espacio", () => ({ "x-api-key": tenantA.apiKey })],
  ])("%s: 401 y no entrega nada", async (_name, headers) => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, { provider: "openai" }, headers());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    const text = await response.text();
    expect(text).not.toContain(KEY_A);
    expect(JSON.parse(text)).toMatchObject({ code: "unauthorized" });
  });

  it("la autenticación va ANTES de mirar el trabajo: un id inexistente sin token es 401, no 404", async () => {
    expect((await ask(internal, randomUUID(), { provider: "openai" }, {})).status).toBe(401);
  });
});

describe("URL base propia (ADR 0022)", () => {
  const insertWithUrl = async (tenantId: string, key: string, urlCiphertext: string, host: string): Promise<void> => {
    await owner.query(
      `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4, "baseUrlCiphertext", "baseUrlHost") VALUES ($1, $2, 'openai', $3, 1, $4, $5, $6)`,
      [randomUUID(), tenantId, cipher.encrypt(key, { tenantId, provider: "openai", keyVersion: 1 }), key.slice(-4), urlCiphertext, host],
    );
  };

  it("entrega { key, baseUrl } cuando el espacio guardó una URL, descifrada y normalizada", async () => {
    const tenant = await createTestTenant("interno-url");
    try {
      const url = "https://api.deepseek.com/v1";
      await insertWithUrl(tenant.id, KEY_A, cipher.encrypt(url, { tenantId: tenant.id, provider: "openai", keyVersion: 1, purpose: "base-url" }), "api.deepseek.com");
      const jobId = await insertJob(tenant.id, "TRANSLATE", "RUNNING", { provider: "openai" });
      const response = await ask(internal, jobId, { provider: "openai" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ key: KEY_A, baseUrl: url });
    } finally {
      await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenant.id]);
    }
  });

  it("sin URL guardada la respuesta es { key } y nada más (el worker usa el host fijo)", async () => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, { provider: "openai" });
    expect(await response.json()).toEqual({ key: KEY_A });
  });

  it("una URL cifrada copiada de otro espacio no se entrega: error genérico, sin la clave ni la URL", async () => {
    const victim = await createTestTenant("interno-url-copiada");
    try {
      const stolen = cipher.encrypt("https://ajeno.example.com/v1", { tenantId: tenantA.id, provider: "openai", keyVersion: 1, purpose: "base-url" });
      await insertWithUrl(victim.id, KEY_B, stolen, "ajeno.example.com");
      const jobId = await insertJob(victim.id, "TRANSLATE", "RUNNING", { provider: "openai" });
      const response = await ask(internal, jobId, { provider: "openai" });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain(KEY_B);
      expect(text).not.toContain("ajeno.example.com");
    } finally {
      await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [victim.id]);
    }
  });
});

describe("entrega", () => {
  it.each(["TRANSLATE", "DUB"])("un trabajo %s en RUNNING recibe la clave en claro de SU espacio, sin caché", async (kind) => {
    const jobId = await insertJob(tenantA.id, kind, "RUNNING", { provider: "openai", voice: "x" });
    const response = await ask(internal, jobId, { provider: "openai" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ key: KEY_A });
  });

  it("el espacio sale de la fila del trabajo, nunca del cuerpo: pedir con el tenantId de otro no cambia nada", async () => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, { provider: "openai", tenantId: tenantB.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: KEY_A });
  });

  it("cada espacio recibe la suya, y un proveedor distinto, la del proveedor", async () => {
    const jobB = await insertJob(tenantB.id, "DUB", "RUNNING", { provider: "elevenlabs" });
    expect(await (await ask(internal, jobB, { provider: "elevenlabs" })).json()).toEqual({ key: ELEVEN_B });
    const jobB2 = await insertJob(tenantB.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    expect(await (await ask(internal, jobB2, { provider: "openai" })).json()).toEqual({ key: KEY_B });
  });
});

describe("el trabajo debe poder usar la clave", () => {
  it.each(["QUEUED", "COMPLETED", "FAILED", "CANCELLED"])("un trabajo en %s: 403 job_not_running", async (status) => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", status, { provider: "openai" });
    const response = await ask(internal, jobId, { provider: "openai" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(KEY_A);
    expect(await (await ask(internal, jobId, { provider: "openai" })).json()).toMatchObject({ code: "job_not_running" });
  });

  it.each(["TRANSCRIBE", "BURN"])("un trabajo %s: 403 job_kind_forbidden (solo TRANSLATE y DUB usan claves externas)", async (kind) => {
    const jobId = await insertJob(tenantA.id, kind, "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, { provider: "openai" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "job_kind_forbidden" });
  });

  it("pedir un proveedor distinto del que declara Job.options.provider: 403 provider_mismatch", async () => {
    const jobId = await insertJob(tenantB.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, { provider: "elevenlabs" }); // el espacio SÍ tiene esa clave
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain(ELEVEN_B);
    expect(JSON.parse(text)).toMatchObject({ code: "provider_mismatch" });
  });

  it.each([
    ["sin options.provider", {}],
    ["provider que no es texto", { provider: 7 }],
    ["provider desconocido", { provider: "argos" }],
  ])("un trabajo con %s no recibe ninguna clave", async (_name, options) => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", options);
    expect((await ask(internal, jobId, { provider: "openai" })).status).toBe(403);
  });

  it("un trabajo que no existe: 404 job_not_found", async () => {
    const response = await ask(internal, randomUUID(), { provider: "openai" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "job_not_found" });
  });

  it("el espacio del trabajo no tiene esa clave: 404 external_key_not_found, sin tomar la de otro espacio", async () => {
    const jobId = await insertJob(tenantA.id, "DUB", "RUNNING", { provider: "elevenlabs" }); // A solo tiene openai; B sí tiene elevenlabs
    const response = await ask(internal, jobId, { provider: "elevenlabs" });
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain(ELEVEN_B);
    expect(JSON.parse(text)).toMatchObject({ code: "external_key_not_found" });
  });

  it("sin APP_SECRET en el API: 503 byok_disabled", async () => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internalOff, jobId, { provider: "openai" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "byok_disabled" });
  });
});

describe("validación de la petición", () => {
  it("un id de trabajo que no es UUID: 400 invalid_job_id", async () => {
    const response = await fetch(`${internal}/internal/v1/jobs/no-es-un-uuid/external-key`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: '{"provider":"openai"}' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_job_id" });
  });

  it.each([
    ["JSON roto", "{provider:"],
    ["sin proveedor", "{}"],
    ["proveedor que no es texto", '{"provider":5}'],
    ["proveedor desconocido", '{"provider":"anthropic"}'],
    ["un arreglo", "[]"],
  ])("%s: 400 sin repetir lo recibido", async (_name, body) => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, body);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("anthropic");
    expect(text).not.toContain(KEY_A);
  });

  it("un cuerpo enorme se corta con 413 sin leerlo entero", async () => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    const response = await ask(internal, jobId, JSON.stringify({ provider: "openai", relleno: "x".repeat(64 * 1024) }));
    expect(response.status).toBe(413);
  });
});

describe("superficie mínima", () => {
  it.each([
    ["GET", "/internal/v1/jobs/" + randomUUID() + "/external-key"],
    ["PUT", "/internal/v1/jobs/" + randomUUID() + "/external-key"],
    ["DELETE", "/internal/v1/jobs/" + randomUUID() + "/external-key"],
  ])("%s %s: 405 (solo POST)", async (method, path) => {
    const response = await fetch(`${internal}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it.each(["/", "/health", "/metrics", "/v1/jobs", "/v1/capabilities", "/internal", "/internal/v1/jobs", "/internal/v2/jobs/x/external-key"])("%s: 404, con o sin token", async (path) => {
    expect((await fetch(`${internal}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${internal}${path}`)).status).toBe(404);
  });

  it("el puerto PÚBLICO del mismo API no sirve la ruta interna", async () => {
    const jobId = await insertJob(tenantA.id, "TRANSLATE", "RUNNING", { provider: "openai" });
    for (const base of [publicBase]) {
      const response = await fetch(`${base}${PATH(jobId)}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-requested-with": "captionforge" }, body: '{"provider":"openai"}' });
      expect([401, 403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(KEY_A);
    }
  });
});

describe("límite de peticiones", () => {
  it("pasado el máximo por minuto responde 429 con Retry-After, también a quien no tiene token (frena el ataque al token)", async () => {
    const limited = await start(APP_SECRET, 5);
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await fetch(`${limited.internalUrl}/internal/v1/jobs/${randomUUID()}/external-key`, { method: "POST", headers: { authorization: "Bearer mal" }, body: "{}" })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429, 429]);
    const blocked = await fetch(`${limited.internalUrl}/internal/v1/jobs/${randomUUID()}/external-key`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
