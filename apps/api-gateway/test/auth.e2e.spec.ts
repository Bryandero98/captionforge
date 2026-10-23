// Inicio de sesión (ADR 0016) contra el API completo y un proveedor falso: flujo de código con PKCE y state, sesiones por cookie,
// CSRF, claves de API creadas desde la sesión y aislamiento entre personas.
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROVIDERS } from "../src/auth/providers.js";
import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { MAX_ACTIVE_KEYS } from "../src/auth/account.controller.js";
import { FakeProvider, type FakeProfile } from "./support/fake-provider.js";

const baseConfig = loadConfig();
const provider = new FakeProvider();
const RUN = randomUUID().slice(0, 8);
const CSRF = { "x-requested-with": "captionforge" };

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let prisma: PrismaService;
let owner: pg.Client;
const FIRST_ID = 1_000_000 + Math.floor(Math.random() * 100_000);
let nextId = FIRST_ID;

const profile = (extra: Partial<FakeProfile> = {}): FakeProfile => ({ id: nextId++, login: `u-${RUN}-${nextId}`, name: "Ana Prueba", ...extra });

/** Lo que un navegador recuerda: cookies por nombre. */
class Jar {
  readonly cookies = new Map<string, string>();
  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/Max-Age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

const noFollow = { redirect: "manual" as const };

/** Recorre «Entrar con GitHub» como lo haría un navegador. Devuelve el jar con la sesión y la respuesta del callback. */
async function signIn(who: FakeProfile = profile(), options: { tamper?: (state: string, challenge: string) => { state: string; code: string } } = {}): Promise<{ jar: Jar; callback: Response; profile: FakeProfile }> {
  const jar = new Jar();
  const start = await fetch(`${base}/auth/github/start`, noFollow);
  jar.absorb(start);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  const challenge = authorize.searchParams.get("code_challenge")!;
  const approved = options.tamper?.(state, challenge) ?? { state, code: provider.approve(challenge, who) };
  const callback = await fetch(`${base}/auth/github/callback?code=${approved.code}&state=${approved.state}`, { ...noFollow, headers: { cookie: jar.header } });
  jar.absorb(callback);
  return { jar, callback, profile: who };
}

const api = (jar: Jar, path: string, init: RequestInit & { csrf?: boolean } = {}): Promise<Response> => {
  const { csrf = false, ...rest } = init;
  return fetch(`${base}${path}`, { ...rest, headers: { cookie: jar.header, ...(csrf ? CSRF : {}), ...(rest.headers as Record<string, string> | undefined) } });
};
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  await provider.start();
  app = await createApp(
    { ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, auth: { ...baseConfig.auth, localMode: false, publicUrl: "http://localhost:3000", providers: { github: provider.config } }, security: { ...baseConfig.security, webApiKey: undefined } },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
});

afterAll(async () => {
  // Los usuarios de estas pruebas tienen identificadores de GitHub numéricos en [FIRST_ID, nextId).
  const users = await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "User" WHERE provider = 'github' AND subject ~ '^[0-9]+$' AND subject::bigint >= $1 AND subject::bigint < $2`, [FIRST_ID, nextId]);
  const tenantIds = new Set(users.rows.map((row) => row.tenantId));
  for (const id of tenantIds) {
    await owner.query(`DELETE FROM "Job" WHERE "tenantId" = $1`, [id]);
    await owner.query(`DELETE FROM "ApiKey" WHERE "tenantId" = $1`, [id]);
    await owner.query(`DELETE FROM "Session" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = $1)`, [id]);
    await owner.query(`DELETE FROM "User" WHERE "tenantId" = $1`, [id]);
    await owner.query(`DELETE FROM "Tenant" WHERE id = $1`, [id]);
  }
  await owner.end();
  await app.close();
  await provider.stop();
});

describe("GET /auth/providers", () => {
  it("dice qué proveedores hay y que no es una instalación local", async () => {
    const response = await fetch(`${base}/auth/providers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: ["github"], localMode: false });
  });
});

describe("flujo de inicio de sesión", () => {
  it("start: redirige al proveedor con state, PKCE S256, scope mínimo y callback, y deja la cookie del intento", async () => {
    const response = await fetch(`${base}/auth/github/start`, noFollow);
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location")!);
    expect(url.origin + url.pathname).toBe(`${provider.url}/authorize`);
    expect(url.searchParams.get("client_id")).toBe(provider.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/github/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(PROVIDERS.github.scope);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith("cf_oauth="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).not.toContain(url.searchParams.get("code_challenge")!); // el desafío es público; la cookie lleva el verificador
  });

  it("un proveedor desconocido o no configurado no inicia nada", async () => {
    for (const name of ["google", "gitlab", "..%2Fx"]) {
      const response = await fetch(`${base}/auth/${name}/start`, noFollow);
      expect(response.status, name).toBe(302);
      expect(response.headers.get("location")).toBe("/?login_error=unavailable");
    }
  });

  it("primer inicio de sesión: crea la persona y su tenant, abre una sesión HttpOnly y devuelve a la interfaz", async () => {
    const who = profile({ emails: [{ email: "Ana@Ejemplo.com", primary: true, verified: true }] });
    const { jar, callback } = await signIn(who);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    const session = callback.headers.getSetCookie().find((line) => line.startsWith("cf_session="))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Max-Age=2592000/); // 30 días
    expect(jar.cookies.has("cf_oauth")).toBe(false); // la cookie del intento se consume

    const user = await prisma.user.findUniqueOrThrow({ where: { provider_subject: { provider: "github", subject: String(who.id) } } });
    expect(user.email).toBe("ana@ejemplo.com");
    expect(user.name).toBe("Ana Prueba");
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    expect(tenant.name).toBe("Ana Prueba");

    const me = (await (await api(jar, "/v1/me")).json()) as { tenant: { id: string }; role: string; user: { id: string; name: string; email: string; provider: string } };
    expect(me.tenant.id).toBe(user.tenantId);
    expect(me.role).toBe("OWNER");
    expect(me.user).toEqual({ id: user.id, name: "Ana Prueba", email: "ana@ejemplo.com", provider: "github" });
  });

  it("la base guarda solo el hash de la sesión, nunca el token de la cookie", async () => {
    const { jar } = await signIn();
    const token = jar.cookies.get("cf_session")!;
    const rows = await owner.query<{ tokenHash: string }>(`SELECT "tokenHash" FROM "Session" WHERE "tokenHash" = $1`, [createHash("sha256").update(token).digest("hex")]);
    expect(rows.rowCount).toBe(1);
    expect(JSON.stringify((await owner.query(`SELECT * FROM "Session" WHERE "tokenHash" = $1`, [rows.rows[0]!.tokenHash])).rows)).not.toContain(token);
  });

  it("volver a entrar reconoce a la misma persona: mismo usuario y mismo tenant, sin duplicar", async () => {
    const who = profile();
    const first = await signIn(who);
    const second = await signIn(who);
    const [a, b] = await Promise.all([api(first.jar, "/v1/me"), api(second.jar, "/v1/me")]);
    expect(((await a.json()) as { tenant: { id: string } }).tenant.id).toBe(((await b.json()) as { tenant: { id: string } }).tenant.id);
    expect(await prisma.user.count({ where: { provider: "github", subject: String(who.id) } })).toBe(1);
  });

  it("sin nombre público usa el nombre de usuario, y un correo SIN verificar no se guarda", async () => {
    const who = profile({ name: null, emails: [{ email: "falso@ejemplo.com", primary: true, verified: false }] });
    const { jar } = await signIn(who);
    const me = (await (await api(jar, "/v1/me")).json()) as { tenant: { name: string }; user: { email: string | null } };
    expect(me.tenant.name).toBe(who.login);
    expect(me.user.email).toBeNull();
  });

  it("dos cuentas con el mismo correo verificado no se fusionan ni fallan: la segunda queda sin correo", async () => {
    const email = `compartido-${RUN}@ejemplo.com`;
    const first = await signIn(profile({ emails: [{ email, primary: true, verified: true }] }));
    const second = await signIn(profile({ emails: [{ email, primary: true, verified: true }] }));
    expect(second.callback.headers.get("location")).toBe("/");
    const a = (await (await api(first.jar, "/v1/me")).json()) as { tenant: { id: string }; user: { email: string | null } };
    const b = (await (await api(second.jar, "/v1/me")).json()) as { tenant: { id: string }; user: { email: string | null } };
    expect(a.tenant.id).not.toBe(b.tenant.id);
    expect(a.user.email).toBe(email);
    expect(b.user.email).toBeNull();
  });
});

describe("el callback rechaza lo que no sea el flujo legítimo", () => {
  const failed = async (callback: Response, code: string, jar?: Jar): Promise<void> => {
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`/?login_error=${code}`);
    expect(callback.headers.getSetCookie().some((line) => line.startsWith("cf_session=") && !/Max-Age=0/.test(line))).toBe(false);
    if (jar) expect(jar.cookies.has("cf_session")).toBe(false);
  };

  it("state distinto del de la cookie (CSRF de inicio de sesión): rechazado y sin sesión", async () => {
    const { callback, jar } = await signIn(profile(), { tamper: (_state, challenge) => ({ state: "otro-state-inventado", code: provider.approve(challenge, profile()) }) });
    await failed(callback, "state", jar);
  });

  it("sin la cookie del intento: rechazado", async () => {
    const start = await fetch(`${base}/auth/github/start`, noFollow);
    const authorize = new URL(start.headers.get("location")!);
    const code = provider.approve(authorize.searchParams.get("code_challenge")!, profile());
    const callback = await fetch(`${base}/auth/github/callback?code=${code}&state=${authorize.searchParams.get("state")}`, noFollow);
    await failed(callback, "state");
  });

  it("sin state ni code: rechazado", async () => {
    await failed(await fetch(`${base}/auth/github/callback`, noFollow), "state");
  });

  it("la persona negó el permiso (error=access_denied): se dice «denied»", async () => {
    await failed(await fetch(`${base}/auth/github/callback?error=access_denied`, noFollow), "denied");
  });

  it("un código inventado lo rechaza el proveedor: sin sesión y sin detalles del proveedor en la respuesta", async () => {
    const { callback, jar } = await signIn(profile(), { tamper: (state) => ({ state, code: "code-inventado" }) });
    await failed(callback, "provider", jar);
    expect(await callback.text()).not.toContain("bad_verification_code");
  });

  it("PKCE: un verificador que no corresponde al desafío no canjea el código", async () => {
    const start = await fetch(`${base}/auth/github/start`, noFollow);
    const authorize = new URL(start.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const code = provider.approve(authorize.searchParams.get("code_challenge")!, profile());
    const callback = await fetch(`${base}/auth/github/callback?code=${code}&state=${state}`, { ...noFollow, headers: { cookie: `cf_oauth=${state}.verificador-falso` } });
    await failed(callback, "provider");
  });

  it("un código ya usado no sirve otra vez (el callback no se puede repetir)", async () => {
    const { jar } = await signIn();
    const start = await fetch(`${base}/auth/github/start`, noFollow);
    const authorize = new URL(start.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const code = provider.approve(authorize.searchParams.get("code_challenge")!, profile());
    const attempt = start.headers.getSetCookie().find((line) => line.startsWith("cf_oauth="))!.split(";")[0]!;
    const url = `${base}/auth/github/callback?code=${code}&state=${state}`;
    expect((await fetch(url, { ...noFollow, headers: { cookie: attempt } })).headers.get("location")).toBe("/");
    await failed(await fetch(url, { ...noFollow, headers: { cookie: attempt } }), "provider");
    expect(jar.cookies.has("cf_session")).toBe(true);
  });

  it("el canje manda el secreto y el verificador al proveedor, no al navegador", async () => {
    const { callback } = await signIn();
    expect(callback.headers.get("location")).toBe("/");
    const last = provider.tokenRequests.at(-1)!;
    expect(last.get("client_secret")).toBe(provider.clientSecret);
    expect(last.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
    expect(last.get("grant_type")).toBe("authorization_code");
    expect(callback.headers.get("location")).not.toContain(provider.clientSecret);
  });
});

describe("sesiones y CSRF", () => {
  it("sin sesión ni clave: 401", async () => {
    expect((await fetch(`${base}/v1/me`)).status).toBe(401);
    expect((await fetch(`${base}/v1/jobs`)).status).toBe(401);
  });

  it("una cookie inventada o caducada no vale", async () => {
    expect((await fetch(`${base}/v1/me`, { headers: { cookie: "cf_session=inventada" } })).status).toBe(401);
    const { jar } = await signIn();
    await owner.query(`UPDATE "Session" SET "expiresAt" = now() - interval '1 minute' WHERE "tokenHash" = $1`, [createHash("sha256").update(jar.cookies.get("cf_session")!).digest("hex")]);
    expect((await api(jar, "/v1/me")).status).toBe(401);
  });

  it("las lecturas con sesión no piden la cabecera de la interfaz, pero lo que MODIFICA sí (403 sin ella)", async () => {
    const { jar } = await signIn();
    expect((await api(jar, "/v1/jobs")).status).toBe(200);
    const blocked = await api(jar, "/v1/keys", json({ name: "x" }));
    expect(blocked.status).toBe(403);
    const allowed = await api(jar, "/v1/keys", { ...json({ name: "x" }), csrf: true });
    expect(allowed.status).toBe(201);
  });

  it("una clave de API inválida NO cae a la cookie válida: 401", async () => {
    const { jar } = await signIn();
    const response = await api(jar, "/v1/jobs", { headers: { "x-api-key": "cfk_" + "0".repeat(64) } });
    expect(response.status).toBe(401);
  });

  it("cerrar sesión pide la cabecera de la interfaz, borra la sesión y deja de valer la cookie", async () => {
    const { jar } = await signIn();
    expect((await api(jar, "/auth/logout", { method: "POST" })).status).toBe(403);
    expect((await api(jar, "/v1/me")).status).toBe(200); // sigue iniciada
    const out = await api(jar, "/auth/logout", { method: "POST", csrf: true });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().some((line) => line.startsWith("cf_session=") && /Max-Age=0/.test(line))).toBe(true);
    const stale = new Jar();
    stale.cookies.set("cf_session", jar.cookies.get("cf_session")!);
    expect((await api(stale, "/v1/me")).status).toBe(401);
  });
});

describe("claves de API desde la sesión", () => {
  it("se crea con la sesión, el valor completo sale una sola vez y funciona como clave de API", async () => {
    const { jar } = await signIn();
    const created = await api(jar, "/v1/keys", { ...json({ name: "  mi script  " }), csrf: true });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; name: string; prefix: string; key: string };
    expect(key.key).toMatch(/^cfk_[0-9a-f]{64}$/);
    expect(key.name).toBe("mi script");
    expect(key.prefix).toBe(key.key.slice(0, 8));

    const listed = await (await api(jar, "/v1/keys")).json();
    expect(JSON.stringify(listed)).not.toContain(key.key);
    expect((listed as { keys: { id: string }[] }).keys.map((item) => item.id)).toContain(key.id);

    const me = (await (await fetch(`${base}/v1/me`, { headers: { "x-api-key": key.key } })).json()) as { tenant: { id: string }; user: unknown };
    expect(me.user).toBeNull(); // una clave es del tenant, no de una persona
    expect((await fetch(`${base}/v1/jobs`, { headers: { "x-api-key": key.key } })).status).toBe(200);
  });

  it("revocarla la deja sin efecto en la siguiente petición", async () => {
    const { jar } = await signIn();
    const key = (await (await api(jar, "/v1/keys", { ...json({ name: "temporal" }), csrf: true })).json()) as { id: string; key: string };
    expect((await fetch(`${base}/v1/jobs`, { headers: { "x-api-key": key.key } })).status).toBe(200);
    expect((await api(jar, `/v1/keys/${key.id}`, { method: "DELETE", csrf: true })).status).toBe(204);
    expect((await fetch(`${base}/v1/jobs`, { headers: { "x-api-key": key.key } })).status).toBe(401);
    expect((await api(jar, `/v1/keys/${key.id}`, { method: "DELETE", csrf: true })).status).toBe(204); // repetir no falla
  });

  it("una clave de API no puede crear, listar ni revocar claves (solo una sesión)", async () => {
    const { jar } = await signIn();
    const key = (await (await api(jar, "/v1/keys", { ...json({ name: "script" }), csrf: true })).json()) as { id: string; key: string };
    const headers = { "x-api-key": key.key };
    expect((await fetch(`${base}/v1/keys`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "otra" }) })).status).toBe(403);
    expect((await fetch(`${base}/v1/keys`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/v1/keys/${key.id}`, { method: "DELETE", headers })).status).toBe(403);
  });

  it("otra persona no ve ni revoca las claves ajenas (404)", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const key = (await (await api(alice.jar, "/v1/keys", { ...json({ name: "de alice" }), csrf: true })).json()) as { id: string };
    expect((await api(bob.jar, `/v1/keys/${key.id}`, { method: "DELETE", csrf: true })).status).toBe(404);
    const bobKeys = (await (await api(bob.jar, "/v1/keys")).json()) as { keys: { id: string }[] };
    expect(bobKeys.keys.map((item) => item.id)).not.toContain(key.id);
  });

  it("valida el nombre y limita las claves activas por tenant", async () => {
    const { jar } = await signIn();
    for (const body of [{}, { name: "" }, { name: "   " }, { name: 5 }, { name: "x".repeat(61) }]) {
      expect((await api(jar, "/v1/keys", { ...json(body), csrf: true })).status, JSON.stringify(body)).toBe(400);
    }
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) expect((await api(jar, "/v1/keys", { ...json({ name: `k${i}` }), csrf: true })).status).toBe(201);
    expect((await api(jar, "/v1/keys", { ...json({ name: "una más" }), csrf: true })).status).toBe(409);
  });
});

describe("aislamiento entre personas que iniciaron sesión", () => {
  it("la sesión de una persona no ve ni cancela los trabajos de otra (404)", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const data = new FormData();
    data.append("file", new File([new Uint8Array(512).fill(3)], "a.mp4", { type: "video/mp4" }));
    const created = await api(alice.jar, "/v1/jobs/transcribe", { method: "POST", body: data, csrf: true });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    expect((await api(alice.jar, `/v1/jobs/${id}`)).status).toBe(200);
    expect((await api(bob.jar, `/v1/jobs/${id}`)).status).toBe(404);
    expect((await api(bob.jar, `/v1/jobs/${id}/cancel`, { method: "POST", csrf: true })).status).toBe(404);
    const list = (await (await api(bob.jar, "/v1/jobs")).json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((job) => job.id)).not.toContain(id);
    await api(alice.jar, `/v1/jobs/${id}/cancel`, { method: "POST", csrf: true });
  });
});

describe("si el proveedor no responde", () => {
  it("el inicio de sesión falla con un código de la interfaz, sin sesión y sin colgarse", async () => {
    const stopped = new FakeProvider();
    await stopped.start();
    const config = stopped.config;
    await stopped.stop();
    const down = await createApp(
      { ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, auth: { ...baseConfig.auth, localMode: false, publicUrl: "http://localhost:3000", providers: { github: config } } },
      { logger: false },
    );
    await down.listen(0, "127.0.0.1");
    try {
      const downBase = await down.getUrl();
      const start = await fetch(`${downBase}/auth/github/start`, noFollow);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const attempt = start.headers.getSetCookie().find((line) => line.startsWith("cf_oauth="))!.split(";")[0]!;
      const callback = await fetch(`${downBase}/auth/github/callback?code=x&state=${state}`, { ...noFollow, headers: { cookie: attempt } });
      expect(callback.headers.get("location")).toBe("/?login_error=provider");
    } finally {
      await down.close();
    }
  });
});

describe("perfiles de los proveedores", () => {
  it("GitHub: el correo es el primario VERIFICADO; sin ninguno verificado, ninguno", () => {
    const parse = PROVIDERS.github.parseProfile.bind(PROVIDERS.github);
    expect(parse({ id: 7, login: "ana" }, [{ email: "a@x.com", primary: false, verified: true }, { email: "b@x.com", primary: true, verified: true }])).toEqual({ subject: "7", email: "b@x.com", name: "ana" });
    expect(parse({ id: 7, login: "ana" }, [{ email: "a@x.com", primary: true, verified: false }])?.email).toBeNull();
    expect(parse({ login: "sin-id" }, [])).toBeNull();
  });

  it("Google: usa `sub` y solo confía en un correo con email_verified", () => {
    const parse = PROVIDERS.google.parseProfile.bind(PROVIDERS.google);
    expect(parse({ sub: "123", email: "A@X.com", email_verified: true, name: "Ana" }, null)).toEqual({ subject: "123", email: "a@x.com", name: "Ana" });
    expect(parse({ sub: "123", email: "a@x.com", email_verified: false }, null)?.email).toBeNull();
    expect(parse({ email: "a@x.com" }, null)).toBeNull();
  });
});
