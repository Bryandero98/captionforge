// /llms.txt y /openapi.json por HTTP real: públicos en modo local, 404 con LOCAL_MODE=false. Necesita infraestructura (npm run infra:up).
import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { disposeTestTenants, sharedTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function start(localMode: boolean): Promise<string> {
  await sharedTenant();
  const app = await createApp({
    ...baseConfig,
    port: 0,
    webRoot: undefined,
    auth: { ...baseConfig.auth, localMode },
    reaper: { ...baseConfig.reaper, intervalMs: 0 },
    security: { ...baseConfig.security, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, uploadMinBytesPerSecond: 0 },
  });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
}

afterAll(async () => {
  for (const app of apps) await app.close();
  await disposeTestTenants();
});

describe("acceso para IAs", () => {
  it("en modo local sirve llms.txt y openapi.json sin clave", async () => {
    const base = await start(true);
    const llms = await fetch(`${base}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toContain("text/plain");
    expect(await llms.text()).toContain("# CaptionForge");
    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { openapi: string; servers: { url: string }[] };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0]?.url).toMatch(/^http/);
  });

  it("con LOCAL_MODE=false responde 404 en ambas rutas", async () => {
    const base = await start(false);
    expect((await fetch(`${base}/llms.txt`)).status).toBe(404);
    expect((await fetch(`${base}/openapi.json`)).status).toBe(404);
  });
});
