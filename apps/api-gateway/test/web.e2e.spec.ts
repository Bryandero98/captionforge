// Servicio de la interfaz web (apps/web) desde el propio API: mismo origen, sin CORS, con CSP restrictiva.
// PostgreSQL, Redis y S3 reales; la raíz estática es un directorio temporal con un archivo "secreto" al lado,
// para comprobar que no se sale de la raíz.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
let parent = "";
let root = "";

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "cf-web-"));
  root = join(parent, "public");
  mkdirSync(join(root, "js"), { recursive: true });
  writeFileSync(join(parent, "secreto.txt"), "no debe salir de la raíz");
  writeFileSync(join(root, "index.html"), '<!doctype html><title>CaptionForge</title><script type="module" src="/js/main.js"></script>');
  writeFileSync(join(root, "style.css"), "body{margin:0}");
  writeFileSync(join(root, "js", "main.js"), "export const ok = true;\n");
  writeFileSync(join(root, ".env"), "SECRETO=1");
});

afterAll(async () => {
  for (const app of apps) await app.close();
  rmSync(parent, { recursive: true, force: true });
});

async function start(overrides: { webRoot?: string | undefined; rateLimitPerMinute?: number } = {}): Promise<number> {
  const app = await createApp(
    {
      ...baseConfig,
      webRoot: "webRoot" in overrides ? overrides.webRoot : root,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      security: {
        apiKey: undefined,
        rateLimitPerMinute: overrides.rateLimitPerMinute ?? 0,
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
      },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return Number(new URL(await app.getUrl()).port);
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** http.request y no fetch: fetch normaliza rutas (`/..`) y no deja fijar Host ni Origin. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(parts).toString() }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Directivas de una CSP como mapa nombre -> valores. */
function directives(csp: string | string[] | undefined): Map<string, string[]> {
  const value = Array.isArray(csp) ? csp.join(";") : (csp ?? "");
  return new Map(
    value
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name !== "" && name !== undefined)
      .map(([name, ...values]) => [name as string, values]),
  );
}

describe("la interfaz se sirve desde el propio API", () => {
  it("GET / devuelve index.html con su tipo de contenido", async () => {
    const port = await start();
    const reply = await send(port, "GET", "/");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toMatch(/^text\/html/);
    expect(reply.body).toContain("<title>CaptionForge</title>");
  });

  it("sirve los módulos ES con tipo JavaScript y el CSS", async () => {
    const port = await start();
    const script = await send(port, "GET", "/js/main.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toMatch(/javascript/);
    expect(script.body).toContain("export const ok");
    const css = await send(port, "GET", "/style.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
  });

  it("HEAD funciona y no devuelve cuerpo", async () => {
    const port = await start();
    const reply = await send(port, "HEAD", "/");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("");
  });

  it("se puede revalidar: ETag y 304, sin el 'no-store' del API (el hook solo lo pone si falta Cache-Control)", async () => {
    const port = await start();
    const first = await send(port, "GET", "/js/main.js");
    expect(first.headers.etag).toBeTruthy();
    expect(first.headers["cache-control"]).toBeTruthy();
    expect(first.headers["cache-control"]).not.toMatch(/no-store/);
    const second = await send(port, "GET", "/js/main.js", { "if-none-match": String(first.headers.etag) });
    expect(second.status).toBe(304);
  });
});

describe("CSP y cabeceras de seguridad de la estática", () => {
  it("la CSP es restrictiva: todo del mismo origen, sin inline, sin eval, sin comodines", async () => {
    const port = await start();
    const reply = await send(port, "GET", "/");
    const csp = directives(reply.headers["content-security-policy"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("style-src")).toEqual(["'self'"]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:"]);
    expect(csp.get("media-src")).toEqual(["'self'", "blob:"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    const todo = [...csp.values()].flat();
    expect(todo).not.toContain("'unsafe-inline'");
    expect(todo).not.toContain("'unsafe-eval'");
    expect(todo).not.toContain("*");
    expect(todo.filter((value) => /^https?:/.test(value))).toEqual([]);
  });

  it("la CSP acompaña a todos los archivos estáticos, no solo al HTML", async () => {
    const port = await start();
    for (const path of ["/", "/style.css", "/js/main.js"]) {
      const reply = await send(port, "GET", path);
      expect(reply.headers["content-security-policy"], path).toBeTruthy();
      expect(reply.headers["x-content-type-options"], path).toBe("nosniff");
      expect(reply.headers["referrer-policy"], path).toBe("no-referrer");
    }
  });
});

describe("la estática no abre una puerta a otros archivos", () => {
  it.each(["/../secreto.txt", "/%2e%2e/secreto.txt", "/js/../../secreto.txt", "/%2e%2e%2fsecreto.txt", "/js/%2e%2e/%2e%2e/secreto.txt"])(
    "%s no sale de la raíz",
    async (path) => {
      const port = await start();
      const reply = await send(port, "GET", path);
      expect(reply.body).not.toContain("no debe salir");
      expect([400, 403, 404]).toContain(reply.status);
    },
  );

  it("los archivos que empiezan por punto no se sirven", async () => {
    const port = await start();
    const reply = await send(port, "GET", "/.env");
    expect(reply.body).not.toContain("SECRETO");
    expect([403, 404]).toContain(reply.status);
  });

  it("no lista directorios", async () => {
    const port = await start();
    const reply = await send(port, "GET", "/js/");
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain("main.js");
  });

  it("solo GET y HEAD: un POST a / no sirve el archivo", async () => {
    const port = await start();
    const reply = await send(port, "POST", "/");
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain("<title>");
  });
});

describe("la estática convive con el API", () => {
  it("/health y las rutas del API siguen respondiendo JSON con el formato de siempre", async () => {
    const port = await start();
    expect((await send(port, "GET", "/health")).status).toBe(200);
    const missing = await send(port, "GET", `/v1/jobs/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ statusCode: 404, error: "Not Found" });
  });

  it("una ruta desconocida del API da el 404 JSON de Nest, no el de la estática", async () => {
    const port = await start();
    const reply = await send(port, "GET", "/v1/no-existe");
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toMatchObject({ statusCode: 404 });
  });

  it("sin raíz web configurada no se sirve nada en /", async () => {
    const port = await start({ webRoot: undefined });
    const reply = await send(port, "GET", "/");
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toMatchObject({ statusCode: 404 });
  });
});

describe("la guardia de Host y Origin protege también la estática", () => {
  it("un Host ajeno recibe 421 (DNS rebinding)", async () => {
    const port = await start();
    expect((await send(port, "GET", "/", { host: "evil.example" })).status).toBe(421);
  });

  it("el mismo origen (Origin igual al Host) pasa: la interfaz habla con el API sin CORS", async () => {
    const port = await start();
    const host = `127.0.0.1:${port}`;
    expect((await send(port, "GET", "/", { host, origin: `http://${host}` })).status).toBe(200);
  });

  it("un Origin ajeno recibe 403", async () => {
    const port = await start();
    expect((await send(port, "GET", "/", { origin: "http://evil.example" })).status).toBe(403);
  });

  it("el HTML no lleva CORS: no hace falta ALLOWED_ORIGINS para servir la interfaz", async () => {
    const port = await start();
    const reply = await send(port, "GET", "/");
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("límite de uso", () => {
  it("la estática no gasta el contador de la API: con 5 por minuto, 20 cargas de la interfaz no lo agotan", async () => {
    const port = await start({ rateLimitPerMinute: 5 });
    for (let i = 0; i < 20; i++) expect((await send(port, "GET", "/style.css")).status).toBe(200);
    expect((await send(port, "GET", `/v1/jobs/${randomUUID()}`)).status).toBe(404);
  });

  it("y el límite sigue vigente para el API", async () => {
    const port = await start({ rateLimitPerMinute: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await send(port, "GET", `/v1/jobs/${randomUUID()}`)).status);
    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
  });
});
