// API de claves externas propias (ADR 0020): solo el Dueño, con sesión; la clave nunca vuelve en una respuesta y en la base solo
// existe cifrada. PostgreSQL, Redis y S3 reales (npm run infra:up).
import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { ExternalKeyCipher } from "../src/external-keys/external-key-crypto.js";
import { createApp } from "../src/main.js";
import { hashApiKey } from "../src/tenancy/api-key.js";
import type { Role } from "../src/tenancy/roles.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const APP_SECRET = "claves-externas-e2e-secreto-de-32-bytes!!";
const CSRF = { "x-requested-with": "captionforge" };
const CANARY = `sk-canario-${randomBytes(18).toString("hex")}`;
const ELEVEN = `eleven-canario-${randomBytes(18).toString("hex")}`;
const PATH = "/v1/workspaces/current/external-keys";

const baseConfig = loadConfig();
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
let on: string; // API con APP_SECRET
let off: string; // API sin APP_SECRET: la función está apagada
let owner: pg.Client;
let tenant: TestTenant;
let otherTenant: TestTenant;
const userIds: string[] = [];
const cookies = new Map<string, string>();
let ownerId = "";
let otherOwnerCookie = "";

async function newUser(label: string, tenantId: string, role: Role): Promise<{ id: string; cookie: string }> {
  const id = randomUUID();
  await owner.query(`INSERT INTO "User" (id, "tenantId", name, provider, subject) VALUES ($1, $2, $3, 'github', $4)`, [id, tenantId, label, `ek-${id}`]);
  userIds.push(id);
  await owner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, $3::"Role")`, [id, tenantId, role]);
  const token = randomBytes(32).toString("base64url");
  await owner.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [randomUUID(), id, hashApiKey(token)]);
  return { id, cookie: `cf_session=${token}` };
}

async function start(appSecret: string | undefined): Promise<string> {
  const app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      auth: { ...baseConfig.auth, localMode: false },
      byok: { appSecret },
      security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
    },
    { logger: ["error"] },
  );
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

const call = (base: string, method: string, path: string, cookie: string | undefined, body?: unknown, extra: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(method === "GET" ? {} : CSRF), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const rows = async (tenantId: string): Promise<{ id: string; provider: string; ciphertext: string; keyVersion: number; last4: string; createdBy: string | null; rotatedAt: Date | null }[]> =>
  (await owner.query(`SELECT id, provider::text AS provider, ciphertext, "keyVersion", last4, "createdBy", "rotatedAt" FROM "TenantExternalKey" WHERE "tenantId" = $1 ORDER BY provider`, [tenantId])).rows;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  tenant = await createTestTenant("claves-ext");
  otherTenant = await createTestTenant("claves-ext-otro");
  for (const role of ["VIEWER", "EDITOR", "OWNER"] as const) {
    const user = await newUser(`persona-${role}`, tenant.id, role);
    cookies.set(role, user.cookie);
    if (role === "OWNER") ownerId = user.id;
  }
  otherOwnerCookie = (await newUser("dueno-otro", otherTenant.id, "OWNER")).cookie;
  on = await start(APP_SECRET);
  off = await start(undefined);
}, 60_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = ANY($1::uuid[])`, [[tenant.id, otherTenant.id]]);
  await owner.query(`DELETE FROM "Session" WHERE "userId" = ANY($1::uuid[])`, [userIds]);
  await owner.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [userIds]);
  await disposeTestTenants();
  await owner.end();
});

describe("quién puede gestionar claves externas", () => {
  it.each([
    ["Lector", () => cookies.get("VIEWER")],
    ["Editor", () => cookies.get("EDITOR")],
  ])("%s recibe 403 role_forbidden en las tres operaciones", async (_name, cookie) => {
    for (const [method, path, body] of [
      ["GET", PATH, undefined],
      ["PUT", `${PATH}/openai`, { key: CANARY }],
      ["DELETE", `${PATH}/openai`, undefined],
    ] as const) {
      const response = await call(on, method, path, cookie(), body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "role_forbidden" });
    }
    expect(await rows(tenant.id)).toEqual([]);
  });

  it("una clave de API del espacio (rol Editor estático) tampoco puede", async () => {
    for (const [method, path, body] of [
      ["GET", PATH, undefined],
      ["PUT", `${PATH}/openai`, { key: CANARY }],
      ["DELETE", `${PATH}/openai`, undefined],
    ] as const) {
      const response = await fetch(`${on}${path}`, { method, headers: { "x-api-key": tenant.apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(await rows(tenant.id)).toEqual([]);
  });

  it("sin credenciales responde 401", async () => {
    for (const [method, path] of [["GET", PATH], ["PUT", `${PATH}/openai`], ["DELETE", `${PATH}/openai`]] as const) {
      expect((await call(on, method, path, undefined, method === "PUT" ? { key: CANARY } : undefined)).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("guardar, listar y borrar (Dueño)", () => {
  it("empieza vacío", async () => {
    const response = await call(on, "GET", PATH, cookies.get("OWNER"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [] });
  });

  it("guarda la clave: la respuesta no la contiene, no se cachea y la base solo tiene el cifrado", async () => {
    const response = await call(on, "PUT", `${PATH}/openai`, cookies.get("OWNER"), { key: CANARY });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("v1."); // ni el cifrado
    expect(JSON.parse(text)).toMatchObject({ provider: "openai", last4: CANARY.slice(-4) });

    const [row] = await rows(tenant.id);
    expect(row).toMatchObject({ provider: "openai", keyVersion: 1, last4: CANARY.slice(-4), createdBy: ownerId });
    expect(row!.ciphertext.startsWith("v1.")).toBe(true);
    // Ninguna columna de texto de la tabla contiene la clave ni un trozo reconocible.
    const everything = JSON.stringify((await owner.query(`SELECT * FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenant.id])).rows);
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(CANARY.slice(3, 30));
    // Y se puede recuperar con el APP_SECRET y el contexto exactos.
    expect(new ExternalKeyCipher(APP_SECRET).decrypt(row!.ciphertext, { tenantId: tenant.id, provider: "openai", keyVersion: 1 })).toBe(CANARY);
  });

  it("el listado muestra proveedor, últimos 4 y fechas; nunca la clave ni el cifrado", async () => {
    const response = await call(on, "GET", PATH, cookies.get("OWNER"));
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("v1.");
    const body = JSON.parse(text) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(Object.keys(body.keys[0]!).sort()).toEqual(["createdAt", "last4", "provider", "rotatedAt"]);
    expect(body.keys[0]).toMatchObject({ provider: "openai", last4: CANARY.slice(-4), rotatedAt: null });
  });

  it("reemplazar la clave del mismo proveedor deja una sola fila, anota la rotación y cifra la nueva", async () => {
    const second = `sk-segunda-${randomBytes(18).toString("hex")}`;
    const response = await call(on, "PUT", `${PATH}/openai`, cookies.get("OWNER"), { key: second });
    expect(response.status).toBe(200);
    const stored = await rows(tenant.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rotatedAt).not.toBeNull();
    expect(stored[0]!.last4).toBe(second.slice(-4));
    expect(new ExternalKeyCipher(APP_SECRET).decrypt(stored[0]!.ciphertext, { tenantId: tenant.id, provider: "openai", keyVersion: 1 })).toBe(second);
  });

  it("dos proveedores conviven; el espacio sale de la sesión, no del cuerpo", async () => {
    const response = await call(on, "PUT", `${PATH}/elevenlabs`, cookies.get("OWNER"), { key: ELEVEN, tenantId: otherTenant.id });
    expect(response.status).toBe(200);
    expect((await rows(tenant.id)).map((row) => row.provider)).toEqual(["elevenlabs", "openai"]);
    expect(await rows(otherTenant.id)).toEqual([]);
    const list = (await (await call(on, "GET", PATH, cookies.get("OWNER"))).json()) as { keys: { provider: string }[] };
    expect(list.keys.map((key) => key.provider).sort()).toEqual(["elevenlabs", "openai"]);
  });

  it("otro espacio no ve, ni sustituye, ni borra las claves de este", async () => {
    const list = await call(on, "GET", PATH, otherOwnerCookie);
    expect(await list.json()).toEqual({ keys: [] });
    const before = await rows(tenant.id);
    const response = await call(on, "DELETE", `${PATH}/openai`, otherOwnerCookie);
    expect(response.status).toBe(404);
    expect(await rows(tenant.id)).toEqual(before);
  });

  it("borrar elimina la fila de verdad; repetirlo da 404", async () => {
    const response = await call(on, "DELETE", `${PATH}/elevenlabs`, cookies.get("OWNER"));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await rows(tenant.id)).map((row) => row.provider)).toEqual(["openai"]);
    const again = await call(on, "DELETE", `${PATH}/elevenlabs`, cookies.get("OWNER"));
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "external_key_not_found" });
  });
});

describe("validación (el mensaje nunca repite lo que se envió)", () => {
  it("un proveedor desconocido es 400", async () => {
    const response = await call(on, "PUT", `${PATH}/anthropic`, cookies.get("OWNER"), { key: CANARY });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_provider" });
  });

  it.each([
    ["sin cuerpo", undefined],
    ["sin key", {}],
    ["key que no es texto", { key: 12345 }],
    ["key vacía", { key: "" }],
    ["key solo espacios", { key: "   " }],
    ["key con espacios en medio", { key: "sk-con espacios dentro de la clave 123456" }],
    ["key con salto de línea en medio", { key: "sk-abcdefghijklmnop\nqrstuvwxyz" }],
    ["key con caracteres no ASCII", { key: "sk-ñandú-abcdefghijklmnopqrstuvwxyz" }],
    ["key demasiado larga", { key: `sk-${"a".repeat(600)}` }],
    ["key de OpenAI sin el prefijo sk-", { key: "abcdefghijklmnopqrstuvwxyz0123456789" }],
    ["key demasiado corta", { key: "sk-corta" }],
  ])("rechaza: %s", async (_name, body) => {
    const response = await call(on, "PUT", `${PATH}/openai`, cookies.get("OWNER"), body);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "invalid_key_format" });
    for (const piece of ["con espacios", "ñandú", "abcdefghijklmnopqrstuvwxyz0123456789", "sk-corta"]) expect(text).not.toContain(piece);
  });

  it("un cuerpo JSON vacío lo rechaza el servidor con 400 y sin guardar nada", async () => {
    const before = await rows(tenant.id);
    const response = await fetch(`${on}${PATH}/openai`, { method: "PUT", headers: { ...CSRF, "content-type": "application/json", cookie: cookies.get("OWNER")! } });
    expect(response.status).toBe(400);
    expect(await rows(tenant.id)).toEqual(before);
  });

  it("los espacios y saltos de línea en los extremos se quitan (error típico al pegar)", async () => {
    const pasted = `sk-pegada-${randomBytes(18).toString("hex")}`;
    expect((await call(on, "PUT", `${PATH}/openai`, cookies.get("OWNER"), { key: `  ${pasted}\r\n` })).status).toBe(200);
    const [row] = await rows(tenant.id);
    expect(new ExternalKeyCipher(APP_SECRET).decrypt(row!.ciphertext, { tenantId: tenant.id, provider: "openai", keyVersion: 1 })).toBe(pasted);
  });
});

describe("sin APP_SECRET (función apagada)", () => {
  it("las tres operaciones responden 404 byok_disabled y no guardan nada", async () => {
    for (const [method, path, body] of [
      ["GET", PATH, undefined],
      ["PUT", `${PATH}/openai`, { key: CANARY }],
      ["DELETE", `${PATH}/openai`, undefined],
    ] as const) {
      const response = await call(off, method, path, cookies.get("OWNER"), body);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({ code: "byok_disabled" });
    }
    const previous = await rows(tenant.id);
    expect(previous.every((row) => row.ciphertext.startsWith("v1."))).toBe(true); // nada nuevo ni en claro
  });
});
