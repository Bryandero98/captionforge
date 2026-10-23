// Autorización por rol (ADR 0019): TODAS las rutas del API, con una sesión de Lector, de Editor y de Dueño, y con una clave de API.
// La tabla EXPECTED es la política escrita a mano; una prueba comprueba que cubre exactamente las rutas que existen, así que
// una ruta nueva sin clasificar rompe la prueba en lugar de quedar abierta por descuido.
import { randomBytes, randomUUID } from "node:crypto";

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountController } from "../src/auth/account.controller.js";
import { AuthController } from "../src/auth/auth.controller.js";
import { CapabilitiesController } from "../src/capabilities/capabilities.controller.js";
import { loadConfig } from "../src/config/config.js";
import { HealthController } from "../src/health/health.controller.js";
import { JobsController } from "../src/jobs/jobs.controller.js";
import { createApp } from "../src/main.js";
import { hashApiKey } from "../src/tenancy/api-key.js";
import { requiredRole, satisfies, type Role } from "../src/tenancy/roles.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const ROLES: Role[] = ["VIEWER", "EDITOR", "OWNER"];
const CSRF = { "x-requested-with": "captionforge" };

/** La política: rol mínimo de cada ruta, o «public». Cambiarla es una decisión de seguridad y se revisa como tal. */
const EXPECTED: Record<string, Role | "public"> = {
  "GET /health": "public",
  "GET /v1/capabilities": "public",
  "GET /auth/providers": "public",
  "GET /auth/:provider/start": "public",
  "GET /auth/:provider/callback": "public",
  "POST /auth/logout": "public",
  "GET /v1/me": "VIEWER",
  "GET /v1/keys": "OWNER",
  "POST /v1/keys": "OWNER",
  "DELETE /v1/keys/:id": "OWNER",
  "POST /v1/jobs/transcribe": "EDITOR",
  "GET /v1/jobs": "VIEWER",
  "GET /v1/jobs/:id": "VIEWER",
  "POST /v1/jobs/:id/cancel": "EDITOR",
  "GET /v1/jobs/:id/events": "VIEWER",
  "GET /v1/jobs/:id/segments": "VIEWER",
  "PUT /v1/jobs/:id/segments": "EDITOR",
  "POST /v1/jobs/:id/burn": "EDITOR",
  "GET /v1/jobs/:id/artifacts/:name": "VIEWER",
};

/** Las rutas que existen de verdad, leídas de los decoradores de los controladores (no de una lista aparte). */
function discoverRoutes(): string[] {
  const found: string[] = [];
  for (const controller of [HealthController, CapabilitiesController, AuthController, AccountController, JobsController]) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      if (typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
      const full = `/${[base, path].filter((part) => part !== "" && part !== "/").join("/")}`;
      found.push(`${RequestMethod[method]} ${full}`);
    }
  }
  return found.sort();
}

/** Una URL concreta para la ruta, con ids que no existen: así una petición permitida termina en 400/404, sin efectos. */
function urlFor(route: string): { method: string; path: string } {
  const [method = "GET", pattern = "/"] = route.split(" ");
  const path = pattern.replace(":provider", "github").replace(":name", "srt").replace(/:id/g, randomUUID());
  return { method, path };
}

const baseConfig = loadConfig();
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let owner: pg.Client;
let tenant: TestTenant; // el espacio donde están las tres personas
let otherTenant: TestTenant; // un segundo espacio, para el rol por espacio
const cookies = new Map<string, string>(); // "VIEWER" | "EDITOR" | "OWNER" -> cabecera Cookie
const userIds: string[] = [];

async function newUser(label: string, tenantId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(`INSERT INTO "User" (id, "tenantId", name, provider, subject) VALUES ($1, $2, $3, 'github', $4)`, [id, tenantId, label, `roles-${id}`]);
  userIds.push(id);
  return id;
}

async function member(userId: string, tenantId: string, role: Role): Promise<void> {
  await owner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, $3::"Role")`, [userId, tenantId, role]);
}

async function sessionFor(userId: string, activeTenantId: string | null = null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await owner.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt", "tenantId") VALUES ($1, $2, $3, now() + interval '1 day', $4)`, [randomUUID(), userId, hashApiKey(token), activeTenantId]);
  return `cf_session=${token}`;
}

async function call(route: string, credentials: { cookie?: string; apiKey?: string }): Promise<Response> {
  const { method, path } = urlFor(route);
  const headers: Record<string, string> = {};
  if (credentials.cookie) Object.assign(headers, { cookie: credentials.cookie }, method === "GET" ? {} : CSRF);
  if (credentials.apiKey) headers["x-api-key"] = credentials.apiKey;
  return fetch(`${base}${path}`, { method, headers, redirect: "manual", signal: AbortSignal.timeout(8000) });
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  tenant = await createTestTenant("roles");
  otherTenant = await createTestTenant("roles-otro");
  for (const role of ROLES) {
    const userId = await newUser(`persona-${role}`, tenant.id);
    await member(userId, tenant.id, role);
    cookies.set(role, await sessionFor(userId));
  }
  app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      auth: { ...baseConfig.auth, localMode: false },
      security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  // Sesiones y personas primero (las membresías caen en cascada): un espacio con miembros no se puede borrar.
  await owner.query(`DELETE FROM "Session" WHERE "userId" = ANY($1::uuid[])`, [userIds]);
  await owner.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [userIds]);
  await disposeTestTenants();
  await owner.end();
});

describe("la política", () => {
  it("cubre exactamente las rutas que existen (una ruta nueva sin clasificar rompe esta prueba)", () => {
    expect(discoverRoutes()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("por método: leer pide Lector y todo lo que modifica pide Editor, salvo lo declarado", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) expect(requiredRole(method, undefined)).toBe("VIEWER");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(requiredRole(method, undefined)).toBe("EDITOR");
    expect(requiredRole("GET", "OWNER")).toBe("OWNER");
  });

  it("cada rol puede todo lo del anterior y nada de lo del siguiente", () => {
    const allowed = ROLES.map((actual) => ROLES.filter((required) => satisfies(actual, required)));
    expect(allowed).toEqual([["VIEWER"], ["VIEWER", "EDITOR"], ["VIEWER", "EDITOR", "OWNER"]]);
  });
});

const PROTECTED = Object.entries(EXPECTED).filter((entry): entry is [string, Role] => entry[1] !== "public");

describe.each(ROLES)("sesión de %s", (actual) => {
  it.each(PROTECTED)("%s (mínimo %s)", async (route, required) => {
    const response = await call(route, { cookie: cookies.get(actual) });
    if (satisfies(actual, required)) {
      expect([401, 403], `${actual} debería poder ${route}`).not.toContain(response.status);
    } else {
      expect(response.status, `${actual} no debería poder ${route}`).toBe(403);
      expect(JSON.stringify(await response.json())).toMatch(/rol/i);
    }
  });
});

describe("clave de API (actúa siempre como Editor)", () => {
  it.each(PROTECTED)("%s (mínimo %s)", async (route, required) => {
    const response = await call(route, { apiKey: tenant.apiKey });
    if (satisfies("EDITOR", required)) expect([401, 403], `la clave debería poder ${route}`).not.toContain(response.status);
    else expect(response.status, `la clave no debería poder ${route}`).toBe(403);
  });
});

describe("sin credenciales", () => {
  it.each(PROTECTED)("%s responde 401", async (route) => {
    expect((await call(route, {})).status).toBe(401);
  });

  it("las rutas públicas no piden nada", async () => {
    // Las de inicio de sesión (start, callback, logout) redirigen o piden la cabecera de la interfaz: no son lecturas abiertas.
    for (const route of ["GET /health", "GET /v1/capabilities", "GET /auth/providers"]) expect((await call(route, {})).status, route).toBe(200);
  });
});

describe("el rol es por espacio de trabajo", () => {
  it("la misma persona es Lector en un espacio y Dueña en otro, según el espacio activo de su sesión", async () => {
    const userId = await newUser("persona-doble", tenant.id);
    await member(userId, tenant.id, "VIEWER");
    await member(userId, otherTenant.id, "OWNER");

    const inFirst = await sessionFor(userId, tenant.id);
    const inSecond = await sessionFor(userId, otherTenant.id);

    const first = await fetch(`${base}/v1/me`, { headers: { cookie: inFirst } });
    expect(await first.json()).toMatchObject({ tenant: { id: tenant.id }, role: "VIEWER" });
    expect((await call("GET /v1/keys", { cookie: inFirst })).status).toBe(403);

    const second = await fetch(`${base}/v1/me`, { headers: { cookie: inSecond } });
    expect(await second.json()).toMatchObject({ tenant: { id: otherTenant.id }, role: "OWNER" });
    expect((await call("GET /v1/keys", { cookie: inSecond })).status).toBe(200);
  });

  it("un espacio activo del que la persona NO es miembro no la eleva: vuelve a su primer espacio", async () => {
    const userId = await newUser("persona-intrusa", tenant.id);
    await member(userId, tenant.id, "VIEWER");
    const cookie = await sessionFor(userId, otherTenant.id); // no es miembro de otherTenant
    const me = (await (await fetch(`${base}/v1/me`, { headers: { cookie } })).json()) as { tenant: { id: string }; role: string };
    expect(me.tenant.id).toBe(tenant.id);
    expect(me.role).toBe("VIEWER");
    expect((await call("GET /v1/keys", { cookie })).status).toBe(403);
  });

  it("una persona sin ninguna membresía no tiene identidad utilizable (401), no un rol por defecto", async () => {
    const userId = await newUser("persona-sin-espacio", tenant.id);
    const cookie = await sessionFor(userId);
    expect((await fetch(`${base}/v1/me`, { headers: { cookie } })).status).toBe(401);
    expect((await call("GET /v1/jobs", { cookie })).status).toBe(401);
  });
});
