// GET /v1/capabilities y la regla de identificar hablantes (diarize): solo si el servidor la tiene disponible.
// PostgreSQL, Redis y S3 reales (npm run infra:up).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { disposeTestTenants, sharedTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const LIMITS_AND_BURN = { limits: { verticalMaxSeconds: 600 }, burn: { templates: ["bold-pop", "rounded-sweep", "clean-color"] } };
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function start(diarization: boolean, appSecret?: string, allowPrivateBaseUrls = false, burn?: { verticalMaxSeconds: number }): Promise<{ base: string; prisma: PrismaService }> {
  await sharedTenant();
  const app = await createApp({
    ...baseConfig,
    port: 0,
    webRoot: undefined,
    features: { diarization },
    byok: { ...baseConfig.byok, appSecret, allowPrivateBaseUrls },
    ...(burn ? { burn } : {}),
    reaper: { ...baseConfig.reaper, intervalMs: 0 },
    security: { ...baseConfig.security, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, uploadMinBytesPerSecond: 0 },
  });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}`, prisma: app.get(PrismaService) };
}

afterAll(async () => {
  for (const app of apps) await app.close();
  await disposeTestTenants();
});

function form(options: unknown): FormData {
  const data = new FormData();
  data.append("options", JSON.stringify(options));
  data.append("file", new Blob([new Uint8Array(2048)], { type: "video/mp4" }), "dialogo.mp4");
  return data;
}

describe("GET /v1/capabilities", () => {
  it("dice si identificar hablantes está disponible, sin exponer nada más", async () => {
    for (const enabled of [true, false]) {
      const { base } = await start(enabled);
      const response = await fetch(`${base}/v1/capabilities`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ diarization: { enabled }, byok: { enabled: false, providers: [], allowPrivateBaseUrls: false }, ...LIMITS_AND_BURN });
    }
  });

  it("publica el tope del formato vertical que realmente aplica el servidor (configurable) y las plantillas del contrato", async () => {
    const { base } = await start(false, undefined, false, { verticalMaxSeconds: 90 });
    const body = (await (await fetch(`${base}/v1/capabilities`)).json()) as { limits: { verticalMaxSeconds: number }; burn: { templates: string[] } };
    expect(body.limits.verticalMaxSeconds).toBe(90);
    // Las plantillas anunciadas son exactamente las que acepta el esquema del contrato: no pueden divergir.
    const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../packages/contracts/schemas/burn-job.v1.json"), "utf8")) as {
      properties: { options: { properties: { template: { enum: string[] } } } };
    };
    expect(body.burn.templates).toEqual(schema.properties.options.properties.template.enum);
  });

  it("anuncia las claves externas propias solo con APP_SECRET, con los proveedores y sin exponer el secreto", async () => {
    const secret = "capacidades-secreto-de-32-bytes-o-mas!!";
    const { base } = await start(false, secret);
    const response = await fetch(`${base}/v1/capabilities`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ diarization: { enabled: false }, byok: { enabled: true, providers: ["openai", "elevenlabs"], allowPrivateBaseUrls: false }, ...LIMITS_AND_BURN });
    expect(text).not.toContain(secret);
  });

  it("avisa de que se aceptan servidores locales (ALLOW_PRIVATE_BASE_URLS) solo si la función está activa", async () => {
    const secret = "capacidades-secreto-de-32-bytes-o-mas!!";
    const on = await start(false, secret, true);
    expect(((await (await fetch(`${on.base}/v1/capabilities`)).json()) as { byok: unknown }).byok).toEqual({ enabled: true, providers: ["openai", "elevenlabs"], allowPrivateBaseUrls: true });
    const off = await start(false, undefined, true); // sin APP_SECRET no hay BYOK, y lo local tampoco se anuncia
    expect(((await (await fetch(`${off.base}/v1/capabilities`)).json()) as { byok: unknown }).byok).toEqual({ enabled: false, providers: [], allowPrivateBaseUrls: false });
  });
});

describe("options.diarize", () => {
  it("con la capacidad activa se acepta, se guarda y se devuelve", async () => {
    const { base, prisma } = await start(true);
    const response = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: form({ diarize: true }) });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; options: Record<string, unknown> };
    expect(job.options).toMatchObject({ diarize: true });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).options).toMatchObject({ diarize: true });
  });

  it("sin la capacidad, pedirla da 400 y no deja nada guardado; false y ausente siguen funcionando", async () => {
    const { base, prisma } = await start(false);
    const before = await prisma.job.count();
    const rejected = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: form({ diarize: true }) });
    expect(rejected.status).toBe(400);
    expect(await prisma.job.count()).toBe(before);
    for (const options of [{ diarize: false }, {}]) {
      const ok = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: form(options) });
      expect(ok.status, JSON.stringify(options)).toBe(202);
    }
  });

  it("un valor que no es booleano da 400", async () => {
    const { base } = await start(true);
    for (const bad of ["true", 1, null]) {
      const response = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: form({ diarize: bad }) });
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
  });
});
