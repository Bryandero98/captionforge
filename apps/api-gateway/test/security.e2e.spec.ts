// Clave de API y límites de uso, contra el API completo (PostgreSQL, Redis y S3 reales).
import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";

const KEY = "clave-de-prueba-0123456789abcdef";
const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function start(security: Partial<typeof baseConfig.security>): Promise<string> {
  const app = await createApp(
    { ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, security: { apiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, trustProxy: false, ...security } },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return app.getUrl();
}

afterAll(async () => {
  for (const app of apps) await app.close();
});

describe("clave de API (API_KEY)", () => {
  it("sin clave configurada el API queda abierto", async () => {
    const base = await start({});
    expect((await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it("con clave configurada rechaza con 401 y WWW-Authenticate lo que no la trae o la trae mal", async () => {
    const base = await start({ apiKey: KEY });
    const path = `${base}/v1/jobs/00000000-0000-4000-8000-000000000000`;
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer otra-clave" }, { authorization: KEY }, { "x-api-key": "otra" }, { authorization: `Basic ${KEY}` }, { authorization: "Bearer " }];
    for (const headers of attempts) {
      const response = await fetch(path, { headers });
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("acepta Authorization: Bearer y X-API-Key", async () => {
    const base = await start({ apiKey: KEY });
    const path = `${base}/v1/jobs/00000000-0000-4000-8000-000000000000`;
    expect((await fetch(path, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404); // pasó la guardia
    expect((await fetch(path, { headers: { authorization: `bearer ${KEY}` } })).status).toBe(404);
    expect((await fetch(path, { headers: { "x-api-key": KEY } })).status).toBe(404);
  });

  it("protege TODAS las rutas de /v1 (subida, cancelación, segmentos, quemado, descargas), no solo las de lectura", async () => {
    const base = await start({ apiKey: KEY });
    const id = "00000000-0000-4000-8000-000000000000";
    const routes: [string, string][] = [
      ["POST", "/v1/jobs/transcribe"],
      ["GET", `/v1/jobs/${id}`],
      ["POST", `/v1/jobs/${id}/cancel`],
      ["GET", `/v1/jobs/${id}/events`],
      ["GET", `/v1/jobs/${id}/segments`],
      ["PUT", `/v1/jobs/${id}/segments`],
      ["POST", `/v1/jobs/${id}/burn`],
      ["GET", `/v1/jobs/${id}/artifacts/srt`],
    ];
    for (const [method, route] of routes) {
      expect((await fetch(`${base}${route}`, { method })).status, `${method} ${route}`).toBe(401);
    }
  });

  it("/health queda abierto para los sondeos del orquestador", async () => {
    const base = await start({ apiKey: KEY });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("la clave no se filtra en el cuerpo de las respuestas de error", async () => {
    const base = await start({ apiKey: KEY });
    const response = await fetch(`${base}/v1/jobs/x`, { headers: { authorization: `Bearer ${KEY}-mal` } });
    expect(await response.text()).not.toContain(KEY);
  });

  it("rechaza al arrancar una clave demasiado corta", () => {
    expect(() => loadConfig({ ...process.env, API_KEY: "corta" })).toThrow(/API_KEY/);
  });
});

describe("límite de uso", () => {
  it("responde 429 con mensaje en español al pasar el máximo por minuto, y /health no cuenta", async () => {
    const base = await start({ rateLimitPerMinute: 5 });
    const path = `${base}/v1/jobs/00000000-0000-4000-8000-000000000000`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(path)).status);
    expect(codes).toEqual([404, 404, 404, 404, 404, 429, 429]);

    const limited = await fetch(path);
    expect(((await limited.json()) as { message: string }).message).toMatch(/Demasiadas peticiones.*\d+ s/);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    for (let i = 0; i < 10; i++) expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("las subidas tienen su propio contador: consultar el estado no gasta el cupo de subir", async () => {
    const base = await start({ rateLimitPerMinute: 100, uploadRateLimitPerMinute: 2 });
    for (let i = 0; i < 20; i++) await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`);
    const upload = async (): Promise<number> => {
      const data = new FormData();
      data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
      const response = await fetch(`${base}/v1/jobs/transcribe`, { method: "POST", body: data });
      if (response.status === 202) {
        const { id } = (await response.json()) as { id: string };
        await fetch(`${base}/v1/jobs/${id}/cancel`, { method: "POST" });
      }
      return response.status;
    };
    expect([await upload(), await upload(), await upload()]).toEqual([202, 202, 429]);
  });

  it("con 0 no limita", async () => {
    const base = await start({ rateLimitPerMinute: 0 });
    for (let i = 0; i < 30; i++) expect((await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it("el limitador corre antes que la clave: sin clave se agota el cupo de la IP atacante, no el de los demás", async () => {
    const base = await start({ apiKey: KEY, rateLimitPerMinute: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`)).status);
    // El limitador (onRequest) corre antes que la guardia: los intentos sin clave gastan el cupo de SU IP.
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});

describe("configuración", () => {
  it("los valores por defecto activan los límites y dejan la clave sin configurar", () => {
    const env = { ...process.env } as Record<string, string | undefined>;
    for (const name of ["API_KEY", "RATE_LIMIT_PER_MINUTE", "UPLOAD_RATE_LIMIT_PER_MINUTE", "REAPER_INTERVAL_SECONDS", "TRUST_PROXY"]) delete env[name];
    const config = loadConfig(env);
    expect(config.security).toEqual({ apiKey: undefined, rateLimitPerMinute: 240, uploadRateLimitPerMinute: 10, trustProxy: false });
    expect(config.reaper).toEqual({ intervalMs: 60_000, staleRunningMs: 20 * 60_000, queuedGraceMs: 5 * 60_000 });
  });

  it.each([
    ["RATE_LIMIT_PER_MINUTE", "-1"],
    ["UPLOAD_RATE_LIMIT_PER_MINUTE", "diez"],
    ["JOB_STALE_MINUTES", "0"],
    ["REAPER_INTERVAL_SECONDS", "1.5"],
  ])("rechaza %s=%s", (name, value) => {
    expect(() => loadConfig({ ...process.env, [name]: value })).toThrow(new RegExp(name));
  });
});

describe("el límite de las rutas caras no se esquiva", () => {
  it("la URL con letras codificadas (%74ranscribe) cuenta en el contador de subidas", async () => {
    const base = await start({ rateLimitPerMinute: 100, uploadRateLimitPerMinute: 2 });
    const upload = async (path: string): Promise<number> => {
      const data = new FormData();
      data.append("file", new File([new Uint8Array(64).fill(1)], "a.mp4", { type: "video/mp4" }));
      const response = await fetch(`${base}${path}`, { method: "POST", body: data });
      if (response.status === 202) {
        const { id } = (await response.json()) as { id: string };
        await fetch(`${base}/v1/jobs/${id}/cancel`, { method: "POST" });
      }
      return response.status;
    };
    expect([await upload("/v1/jobs/transcribe"), await upload("/v1/jobs/%74ranscribe"), await upload("/v1/jobs/%74ranscribe")]).toEqual([202, 202, 429]);
  });

  it("pedir quemados comparte el tope de las subidas (cada uno es un ffmpeg de horas)", async () => {
    const base = await start({ rateLimitPerMinute: 100, uploadRateLimitPerMinute: 2 });
    const id = "00000000-0000-4000-8000-000000000000";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/v1/jobs/${id}/burn`, { method: "POST" })).status);
    expect(codes).toEqual([404, 404, 429, 429]);
  });
});
