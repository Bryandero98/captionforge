// Límites de uso, contra el API completo (PostgreSQL, Redis y S3 reales). La clave de API y el aislamiento por tenant
// están en tenancy.e2e.spec.ts.
import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { disposeTestTenants, sharedTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function start(security: Partial<typeof baseConfig.security>): Promise<string> {
  await sharedTenant();
  const app = await createApp(
    { ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, security: { webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, trustProxy: false, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, uploadMinBytesPerSecond: 0, uploadRateWindowMs: 30_000, maxEventStreams: 0, maxEventStreamsPerClient: 0, eventStreamMaxMs: 0, allowedOrigins: [], allowedHosts: ["localhost", "127.0.0.1", "[::1]"], ...security } },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return app.getUrl();
}

afterAll(async () => {
  for (const app of apps) await app.close();
  await disposeTestTenants();
});

describe("límite de uso", () => {
  it("/health tiene su propio contador con un tope alto (600 por minuto): ya no es una vía libre para martillear la base de datos", async () => {
    const base = await start({ rateLimitPerMinute: 5, uploadRateLimitPerMinute: 0 });
    const codes: number[] = [];
    for (let batch = 0; batch < 13; batch++) {
      codes.push(...(await Promise.all(Array.from({ length: 50 }, () => fetch(`${base}/health`).then((r) => r.status)))));
    }
    expect(codes.filter((code) => code === 200).length).toBe(600);
    expect(codes.filter((code) => code === 429).length).toBe(50);
    // El contador general de la persona usuaria no se gastó con los sondeos.
    expect((await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

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
    const base = await start({ rateLimitPerMinute: 3 });
    const codes: number[] = [];
    // Cabecera vacía: la prueba no pone su clave y se queda sin autenticar.
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`, { headers: { "x-api-key": "" } })).status);
    // El limitador (onRequest) corre antes que la guardia: los intentos sin clave gastan el cupo de SU IP.
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});

describe("configuración", () => {
  it("los valores por defecto activan los límites y no entregan ninguna clave a la interfaz", () => {
    const env = { ...process.env } as Record<string, string | undefined>;
    for (const name of ["WEB_API_KEY", "RATE_LIMIT_PER_MINUTE", "UPLOAD_RATE_LIMIT_PER_MINUTE", "REAPER_INTERVAL_SECONDS", "TRUST_PROXY", "TENANT_UPLOADS_PER_HOUR", "TENANT_MAX_QUEUED_JOBS", "MAX_CONCURRENT_UPLOADS", "MAX_CONCURRENT_UPLOADS_PER_CLIENT", "UPLOAD_MIN_BYTES_PER_SECOND", "UPLOAD_RATE_WINDOW_SECONDS", "MAX_EVENT_STREAMS", "MAX_EVENT_STREAMS_PER_CLIENT", "EVENT_STREAM_MAX_SECONDS", "ALLOWED_ORIGINS", "ALLOWED_HOSTS"]) delete env[name];
    const config = loadConfig(env);
    expect(config.security).toEqual({
      webApiKey: undefined,
      rateLimitPerMinute: 240,
      uploadRateLimitPerMinute: 10,
      tenantUploadsPerHour: 60,
      tenantMaxQueuedJobs: 20,
      trustProxy: false,
      maxConcurrentUploads: 4,
      maxConcurrentUploadsPerClient: 2,
      uploadMinBytesPerSecond: 16_384,
      uploadRateWindowMs: 30_000,
      maxEventStreams: 200,
      maxEventStreamsPerClient: 10,
      eventStreamMaxMs: 1_800_000,
      allowedOrigins: [],
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
    });
    expect(config.reaper).toEqual({ intervalMs: 60_000, staleRunningMs: 20 * 60_000, queuedGraceMs: 5 * 60_000 });
  });

  it("rechaza al arrancar una WEB_API_KEY demasiado corta y acepta una larga", () => {
    expect(() => loadConfig({ ...process.env, WEB_API_KEY: "corta" })).toThrow(/WEB_API_KEY/);
    expect(loadConfig({ ...process.env, WEB_API_KEY: "cfk_" + "a".repeat(64) }).security.webApiKey).toBe("cfk_" + "a".repeat(64));
  });

  describe("inicio de sesión (ADR 0016)", () => {
    const clean = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
      const env = { ...process.env } as Record<string, string | undefined>;
      for (const name of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_URL", "LOCAL_MODE", "SESSION_TTL_DAYS", "WEB_API_KEY", "PORT"]) delete env[name];
      return { ...env, ...extra };
    };

    it("por defecto: modo local, sin proveedores, dirección local y sesiones de 30 días", () => {
      const { auth } = loadConfig(clean());
      expect(auth.localMode).toBe(true);
      expect(auth.providers).toEqual({ github: undefined, google: undefined });
      expect(auth.publicUrl).toBe("http://localhost:3000");
      expect(auth.sessionTtlMs).toBe(30 * 86_400_000);
    });

    it("un proveedor se activa con su Client ID y su Client Secret, y con uno solo el arranque falla", () => {
      expect(loadConfig(clean({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secreto" })).auth.providers.github).toMatchObject({ clientId: "id", clientSecret: "secreto" });
      expect(() => loadConfig(clean({ GITHUB_CLIENT_ID: "id" }))).toThrow(/GITHUB_CLIENT_ID y GITHUB_CLIENT_SECRET/);
      expect(() => loadConfig(clean({ GOOGLE_CLIENT_SECRET: "secreto" }))).toThrow(/GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET/);
    });

    it("PUBLIC_URL se normaliza a un origen y rechaza rutas, credenciales y esquemas raros", () => {
      expect(loadConfig(clean({ PUBLIC_URL: "https://Captions.Ejemplo.com/" })).auth.publicUrl).toBe("https://captions.ejemplo.com");
      for (const bad of ["captions.ejemplo.com", "ftp://x.com", "https://x.com/app", "https://u:p@x.com", "https://x.com/?a=1"]) {
        expect(() => loadConfig(clean({ PUBLIC_URL: bad })), bad).toThrow(/PUBLIC_URL/);
      }
    });

    it("fuera del modo local (LOCAL_MODE=false) la interfaz no recibe ninguna clave aunque haya WEB_API_KEY", () => {
      const key = "cfk_" + "c".repeat(64);
      expect(loadConfig(clean({ WEB_API_KEY: key })).security.webApiKey).toBe(key);
      expect(loadConfig(clean({ WEB_API_KEY: key, LOCAL_MODE: "false" })).security.webApiKey).toBeUndefined();
    });
  });

  it.each([
    ["true", true],
    ["false", false],
    ["", false],
    ["10.0.0.0/8, 192.168.1.5", ["10.0.0.0/8", "192.168.1.5"]],
  ])("TRUST_PROXY=%j se interpreta como %j (booleano o lista de redes)", (raw, expected) => {
    expect(loadConfig({ ...process.env, TRUST_PROXY: raw }).security.trustProxy).toEqual(expected);
  });

  it.each([
    ["http://localhost:5173", ["http://localhost:5173"]],
    ["http://localhost:5173/", ["http://localhost:5173"]],
    ["HTTPS://App.Ejemplo.com, http://localhost:5173", ["https://app.ejemplo.com", "http://localhost:5173"]],
    ["http://localhost:80", ["http://localhost"]],
    ["", []],
  ])("ALLOWED_ORIGINS=%j se normaliza a %j", (raw, expected) => {
    expect(loadConfig({ ...process.env, ALLOWED_ORIGINS: raw }).security.allowedOrigins).toEqual(expected);
  });

  it.each([
    ["", ["localhost", "127.0.0.1", "[::1]"]],
    ["API.Ejemplo.com, localhost", ["api.ejemplo.com", "localhost"]],
    ["[::1]", ["[::1]"]],
  ])("ALLOWED_HOSTS=%j se interpreta como %j", (raw, expected) => {
    expect(loadConfig({ ...process.env, ALLOWED_HOSTS: raw }).security.allowedHosts).toEqual(expected);
  });

  it.each([
    ["ALLOWED_ORIGINS", "*"],
    ["ALLOWED_ORIGINS", "http://localhost:5173, *"],
    ["ALLOWED_ORIGINS", "localhost:5173"],
    ["ALLOWED_ORIGINS", "http://localhost:5173/app"],
    ["ALLOWED_ORIGINS", "http://usuario@localhost:5173"],
    ["ALLOWED_ORIGINS", "ftp://localhost"],
    ["ALLOWED_HOSTS", "*"],
    ["ALLOWED_HOSTS", "localhost:3000"],
    ["ALLOWED_HOSTS", "http://localhost"],
    ["ALLOWED_HOSTS", "a b"],
  ])("rechaza %s=%j al arrancar (nunca comodines ni valores ambiguos)", (name, value) => {
    expect(() => loadConfig({ ...process.env, [name]: value })).toThrow(name);
  });

  it.each([
    ["RATE_LIMIT_PER_MINUTE", "-1"],
    ["UPLOAD_RATE_LIMIT_PER_MINUTE", "diez"],
    ["MAX_CONCURRENT_UPLOADS", "-2"],
    ["EVENT_STREAM_MAX_SECONDS", "100000"],
    ["TRUST_PROXY", "no-es-una-red"],
    ["TRUST_PROXY", "2"],
    ["UPLOAD_RATE_WINDOW_SECONDS", "0"],
    ["MAX_EVENT_STREAMS_PER_CLIENT", "muchos"],
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
