// Equipos (ADR 0019): invitaciones de un solo uso, regla del Último Dueño, gestión de miembros y cambio de espacio activo.
// Contra PostgreSQL, Redis y S3 reales. Las sesiones se crean con el rol dueño de la base: aquí no se prueba el login.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { hashApiKey } from "../src/tenancy/api-key.js";
import type { Role } from "../src/tenancy/roles.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const baseConfig = loadConfig();
const CSRF = { "x-requested-with": "captionforge" };
const DAY_MS = 86_400_000;

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let owner: pg.Client;
let team: TestTenant;
const userIds: string[] = [];

interface Person {
  id: string;
  cookie: string;
}

async function person(label: string, tenantId: string, role: Role | null): Promise<Person> {
  const id = randomUUID();
  await owner.query(`INSERT INTO "User" (id, "tenantId", name, provider, subject) VALUES ($1, $2, $3, 'github', $4)`, [id, tenantId, label, `ws-${id}`]);
  userIds.push(id);
  if (role !== null) await owner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, $3::"Role")`, [id, tenantId, role]);
  const token = randomBytes(32).toString("base64url");
  await owner.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [randomUUID(), id, hashApiKey(token)]);
  return { id, cookie: `cf_session=${token}` };
}

/** Una persona que acaba de registrarse: Dueña de su propio espacio (como hace el inicio de sesión). */
async function stranger(label: string): Promise<Person & { tenantId: string }> {
  const own = await createTestTenant(label);
  return { ...(await person(label, own.id, "OWNER")), tenantId: own.id };
}

async function call(who: { cookie: string } | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (who) headers.cookie = who.cookie;
  if (who && method !== "GET") Object.assign(headers, CSRF);
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}

const json = async <T = Record<string, unknown>>(response: Response): Promise<T> => (await response.json()) as T;

/** Crea una invitación como Dueño y devuelve el token que va en el enlace. */
async function invite(by: Person, role: Role = "EDITOR"): Promise<{ token: string; id: string }> {
  const response = await call(by, "POST", "/v1/workspaces/invites", { role });
  expect(response.status).toBe(201);
  const body = await json<{ id: string; link: string }>(response);
  const token = new URL(body.link).searchParams.get("invite");
  expect(token, "el enlace lleva el token en ?invite=").toMatch(/^cfi_[A-Za-z0-9_-]{40,}$/);
  return { token: token!, id: body.id };
}

const roleOf = async (userId: string, tenantId = team.id): Promise<string | undefined> =>
  (await owner.query<{ role: string }>(`SELECT role::text AS role FROM "Membership" WHERE "userId" = $1 AND "tenantId" = $2`, [userId, tenantId])).rows[0]?.role;
const owners = async (): Promise<number> => (await owner.query(`SELECT 1 FROM "Membership" WHERE "tenantId" = $1 AND role = 'OWNER'`, [team.id])).rowCount ?? 0;

let ana: Person; // Dueña del equipo
let beto: Person; // Editor
let carla: Person; // Lectora

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  team = await createTestTenant("equipo");
  ana = await person("ana", team.id, "OWNER");
  beto = await person("beto", team.id, "EDITOR");
  carla = await person("carla", team.id, "VIEWER");
  app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      auth: { ...baseConfig.auth, localMode: false, publicUrl: "http://localhost:3000" },
      security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0 },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await owner.query(`DELETE FROM "Invitation" WHERE "tenantId" IN (SELECT "tenantId" FROM "Membership" WHERE "userId" = ANY($1::uuid[]))`, [userIds]);
  await owner.query(`DELETE FROM "Session" WHERE "userId" = ANY($1::uuid[])`, [userIds]);
  await owner.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [userIds]);
  await disposeTestTenants();
  await owner.end();
});

describe("crear invitaciones (solo Dueño)", () => {
  it("devuelve un enlace de un solo uso que vence en 7 días y no guarda el token en claro", async () => {
    const { token, id } = await invite(ana, "EDITOR");
    const row = (await owner.query<{ tokenHash: string; expiresAt: Date; createdAt: Date; role: string; acceptedAt: Date | null }>(`SELECT "tokenHash", "expiresAt", "createdAt", role::text AS role, "acceptedAt" FROM "Invitation" WHERE id = $1`, [id])).rows[0]!;
    expect(row.role).toBe("EDITOR");
    expect(row.acceptedAt).toBeNull();
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("base64url"));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(7 * DAY_MS - 60_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThan(7 * DAY_MS + 60_000);
  });

  it("no se puede invitar como Dueño, ni con un rol inventado, ni sin cuerpo", async () => {
    for (const body of [{ role: "OWNER" }, { role: "ADMIN" }, {}, undefined, { role: 7 }]) {
      expect((await call(ana, "POST", "/v1/workspaces/invites", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("un Editor y una Lectora no pueden", async () => {
    for (const who of [beto, carla]) expect((await call(who, "POST", "/v1/workspaces/invites", { role: "VIEWER" })).status).toBe(403);
  });

  it("hay un tope de invitaciones pendientes por espacio", async () => {
    const crowded = await createTestTenant("lleno");
    const boss = await person("jefa", crowded.id, "OWNER");
    const fill = (count: number, state: "pending" | "accepted" | "revoked" | "expired") =>
      owner.query(
        `INSERT INTO "Invitation" (id, "tenantId", role, "tokenHash", "createdBy", "expiresAt", "acceptedAt", "revokedAt")
         SELECT gen_random_uuid(), $1, 'VIEWER', gen_random_uuid()::text, $2,
                CASE WHEN $4::text = 'expired' THEN now() - interval '1 day' ELSE now() + interval '7 days' END,
                CASE WHEN $4::text = 'accepted' THEN now() END,
                CASE WHEN $4::text = 'revoked' THEN now() END
         FROM generate_series(1, $3::int)`,
        [crowded.id, boss.id, count, state],
      );
    try {
      // Las usadas, revocadas o vencidas NO cuentan: sus filas no se purgan, así que un filtro mal puesto bloquearía el espacio para siempre.
      await fill(20, "accepted");
      await fill(20, "revoked");
      await fill(20, "expired");
      expect((await call(boss, "POST", "/v1/workspaces/invites", { role: "VIEWER" })).status).toBe(201);
      await fill(48, "pending"); // con la creada son 49 vigentes: la 50.ª cabe y la 51.ª no
      expect((await call(boss, "POST", "/v1/workspaces/invites", { role: "VIEWER" })).status).toBe(201);
      const full = await call(boss, "POST", "/v1/workspaces/invites", { role: "VIEWER" });
      expect(full.status).toBe(409);
      expect(await json(full)).toMatchObject({ code: "invite_limit" }); // la interfaz no debe confundirlo con el Último Dueño
    } finally {
      await owner.query(`DELETE FROM "Invitation" WHERE "tenantId" = $1`, [crowded.id]);
    }
  });

  it("ignora un tenantId del cuerpo: la invitación se crea en el espacio activo", async () => {
    const elsewhere = await stranger("otro-tenant-cuerpo");
    const response = await call(ana, "POST", "/v1/workspaces/invites", { role: "VIEWER", tenantId: elsewhere.tenantId });
    expect(response.status).toBe(201);
    const { id } = await json<{ id: string }>(response);
    expect((await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "Invitation" WHERE id = $1`, [id])).rows[0]?.tenantId).toBe(team.id);
  });
});

describe("aceptar una invitación (un solo uso)", () => {
  it("sin sesión responde 401 (para que la interfaz mande a iniciar sesión primero) y con clave de API, 403", async () => {
    const { token } = await invite(ana, "VIEWER");
    expect((await call(null, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(401);
    expect((await call(null, "POST", `/v1/workspaces/invites/${token}/accept`, undefined, { "x-api-key": team.apiKey })).status).toBe(403);
    // No se consumió: sigue vigente.
    const guest = await stranger("invitado-401");
    expect((await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(200);
  });

  it("una persona nueva entra con el rol de la invitación, y a la segunda vez el token ya no sirve (410)", async () => {
    const { token } = await invite(ana, "EDITOR");
    const guest = await stranger("invitado");
    const first = await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`);
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ tenant: { id: team.id }, role: "EDITOR" });
    expect(await roleOf(guest.id)).toBe("EDITOR");

    // Repetirla quien ya la usó es idempotente (la respuesta se pudo perder, o hay dos pestañas): mismo resultado, no un 410 engañoso.
    const again = await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ tenant: { id: team.id }, role: "EDITOR" });
    const other = await stranger("otro");
    expect((await call(other, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(410);
    expect(await roleOf(other.id)).toBeUndefined();
  });

  it("dos personas que aceptan el MISMO token a la vez: solo una entra", async () => {
    const { token } = await invite(ana, "VIEWER");
    const [a, b] = await Promise.all([stranger("carrera-a"), stranger("carrera-b")]);
    const [ra, rb] = await Promise.all([call(a, "POST", `/v1/workspaces/invites/${token}/accept`), call(b, "POST", `/v1/workspaces/invites/${token}/accept`)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 410]);
    const members = [await roleOf(a.id), await roleOf(b.id)].filter((role) => role !== undefined);
    expect(members).toEqual(["VIEWER"]);
  });

  it("una invitación vencida, revocada o desconocida no sirve", async () => {
    const guest = await stranger("invitado-malo");
    const expired = await invite(ana, "VIEWER");
    await owner.query(`UPDATE "Invitation" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    expect((await call(guest, "POST", `/v1/workspaces/invites/${expired.token}/accept`)).status).toBe(410);

    const revoked = await invite(ana, "VIEWER");
    expect((await call(ana, "DELETE", `/v1/workspaces/invites/${revoked.id}`)).status).toBe(204);
    expect((await call(guest, "POST", `/v1/workspaces/invites/${revoked.token}/accept`)).status).toBe(410);

    for (const token of [`cfi_${randomBytes(32).toString("base64url")}`, "cfi_corto", "no-es-un-token"]) {
      expect((await call(guest, "POST", `/v1/workspaces/invites/${encodeURIComponent(token)}/accept`)).status, token.slice(0, 12)).toBe(404);
    }
    // Un parámetro de 300 caracteres lo corta el servidor HTTP (414) antes de llegar al servicio.
    expect([404, 414]).toContain((await call(guest, "POST", `/v1/workspaces/invites/${"x".repeat(300)}/accept`)).status);
    expect(await roleOf(guest.id)).toBeUndefined();
    // Una invitación vencida o revocada ni deja membresía ni queda marcada como aceptada.
    const rows = (await owner.query<{ acceptedAt: Date | null }>(`SELECT "acceptedAt" FROM "Invitation" WHERE id = ANY($1::uuid[])`, [[expired.id, revoked.id]])).rows;
    expect(rows.map((row) => row.acceptedAt)).toEqual([null, null]);
  });

  it("aceptar no baja a nadie de rango (ni con rango igual), pero sí lo sube", async () => {
    const lower = await invite(ana, "VIEWER");
    const same = await call(ana, "POST", `/v1/workspaces/invites/${lower.token}/accept`);
    expect(same.status).toBe(200);
    expect(await json(same)).toMatchObject({ role: "OWNER" }); // la interfaz muestra este valor: la Dueña sigue siendo Dueña
    expect(await roleOf(ana.id)).toBe("OWNER");

    const editor = await person("editora-temporal", team.id, "EDITOR");
    for (const [offered, expected] of [["VIEWER", "EDITOR"], ["EDITOR", "EDITOR"]] as const) {
      const { token } = await invite(ana, offered);
      expect(await json(await call(editor, "POST", `/v1/workspaces/invites/${token}/accept`))).toMatchObject({ role: expected });
      expect(await roleOf(editor.id)).toBe(expected);
    }

    const viewer = await person("lectora-temporal", team.id, "VIEWER");
    const higher = await invite(ana, "EDITOR");
    expect(await json(await call(viewer, "POST", `/v1/workspaces/invites/${higher.token}/accept`))).toMatchObject({ role: "EDITOR" });
    expect(await roleOf(viewer.id)).toBe("EDITOR");
  });

  it("una Lectora de otro espacio también puede aceptar (aceptar no pide ser Editora en su espacio activo)", async () => {
    const { token } = await invite(ana, "VIEWER");
    const viewerElsewhere = await stranger("lector-en-su-espacio");
    await owner.query(`UPDATE "Membership" SET role = 'VIEWER' WHERE "userId" = $1`, [viewerElsewhere.id]);
    expect((await call(viewerElsewhere, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(200);
  });
});

describe("invitaciones pendientes", () => {
  it("el Dueño ve las vigentes, sin el token, y no las de otro espacio", async () => {
    const mine = await invite(ana, "VIEWER");
    const elsewhere = await stranger("otro-espacio");
    const theirs = await invite(elsewhere, "VIEWER");

    const list = await json<{ invites: { id: string; role: string; expiresAt: string }[] }>(await call(ana, "GET", "/v1/workspaces/invites"));
    const ids = list.invites.map((item) => item.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(JSON.stringify(list)).not.toContain(mine.token);
    expect(JSON.stringify(list)).not.toContain("tokenHash");

    // Revocar la de otro espacio es un 404, como todo lo ajeno.
    expect((await call(ana, "DELETE", `/v1/workspaces/invites/${theirs.id}`)).status).toBe(404);
  });
});

describe("regla del Último Dueño", () => {
  it("el único Dueño no puede degradarse ni quitarse (409), y el espacio sigue con Dueño", async () => {
    const solo = await createTestTenant("solo");
    const boss = await person("jefa-sola", solo.id, "OWNER");
    expect((await call(boss, "PUT", `/v1/workspaces/members/${boss.id}`, { role: "EDITOR" })).status).toBe(409);
    expect((await call(boss, "PUT", `/v1/workspaces/members/${boss.id}`, { role: "VIEWER" })).status).toBe(409);
    expect((await call(boss, "DELETE", `/v1/workspaces/members/${boss.id}`)).status).toBe(409);
    expect(await roleOf(boss.id, solo.id)).toBe("OWNER");
  });

  it("con dos Dueños se puede degradar a uno, y entonces el que queda es el último", async () => {
    const duo = await createTestTenant("duo");
    const [x, y] = [await person("x", duo.id, "OWNER"), await person("y", duo.id, "OWNER")];
    expect((await call(x, "PUT", `/v1/workspaces/members/${y.id}`, { role: "EDITOR" })).status).toBe(200);
    expect(await roleOf(y.id, duo.id)).toBe("EDITOR");
    expect((await call(x, "PUT", `/v1/workspaces/members/${x.id}`, { role: "VIEWER" })).status).toBe(409);
    expect((await call(x, "DELETE", `/v1/workspaces/members/${x.id}`)).status).toBe(409);
    // Promover primero y degradar después sí funciona.
    expect((await call(x, "PUT", `/v1/workspaces/members/${y.id}`, { role: "OWNER" })).status).toBe(200);
    expect((await call(x, "PUT", `/v1/workspaces/members/${x.id}`, { role: "VIEWER" })).status).toBe(200);
  });

  it("dos Dueños que se degradan o se expulsan A LA VEZ: uno gana y el espacio nunca se queda sin Dueño", async () => {
    for (const mode of ["degradar", "expulsar"] as const) {
      const duo = await createTestTenant(`carrera-${mode}`);
      const [x, y] = [await person("x", duo.id, "OWNER"), await person("y", duo.id, "OWNER")];
      // Cada uno tiene además su espacio propio: expulsarlo no lo deja sin ninguno (regla `last_membership`), así que aquí solo manda el Último Dueño.
      for (const who of [x, y]) await owner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, 'OWNER')`, [who.id, (await createTestTenant(`propio-${mode}`)).id]);
      const act = (by: Person, target: Person) =>
        mode === "degradar" ? call(by, "PUT", `/v1/workspaces/members/${target.id}`, { role: "VIEWER" }) : call(by, "DELETE", `/v1/workspaces/members/${target.id}`);
      const results = await Promise.all([act(x, y), act(y, x)]);
      const ok = mode === "degradar" ? 200 : 204;
      // El que pierde la carrera recibe 409 (la regla) o, si el otro ya había terminado, 403/401 (ya no tiene rol o espacio).
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((status) => status === ok), mode).toHaveLength(1);
      expect(statuses.find((status) => status !== ok), mode).toBeOneOf([401, 403, 409]);
      const remaining = (await owner.query(`SELECT 1 FROM "Membership" WHERE "tenantId" = $1 AND role = 'OWNER'`, [duo.id])).rowCount;
      expect(remaining, mode).toBe(1);
    }
  });

  it("DETERMINISTA: con la fila de otro Dueño bloqueada, el cambio ESPERA (FOR UPDATE) y al soltarla cuenta bien → 409", async () => {
    const duo = await createTestTenant("bloqueo");
    const [x, y] = [await person("x", duo.id, "OWNER"), await person("y", duo.id, "OWNER")];
    await owner.query("BEGIN");
    let released = false;
    try {
      // Otra transacción (no confirmada) bloquea las filas de los Dueños y degrada a y.
      await owner.query(`SELECT 1 FROM "Membership" WHERE "tenantId" = $1 AND role = 'OWNER' ORDER BY "userId" FOR UPDATE`, [duo.id]);
      await owner.query(`UPDATE "Membership" SET role = 'VIEWER' WHERE "userId" = $1 AND "tenantId" = $2`, [y.id, duo.id]);
      const demote = call(x, "PUT", `/v1/workspaces/members/${x.id}`, { role: "VIEWER" });
      const outcome = await Promise.race([demote.then((r) => r.status), new Promise<"pendiente">((resolve) => setTimeout(() => resolve("pendiente"), 600))]);
      expect(outcome, "sin el bloqueo respondería ya (200) con un recuento viejo de dos Dueños").toBe("pendiente");
      await owner.query("COMMIT");
      released = true;
      expect((await demote).status).toBe(409); // ya solo queda x como Dueño: la regla se evalúa sobre el recuento nuevo
    } finally {
      if (!released) await owner.query("ROLLBACK");
    }
    expect(await roleOf(x.id, duo.id)).toBe("OWNER");
  });

  it("tres Dueños: dos degradaciones simultáneas distintas pasan las dos y queda exactamente uno (el bloqueo no sobre-rechaza)", async () => {
    const trio = await createTestTenant("trio");
    const [x, y, z] = [await person("x", trio.id, "OWNER"), await person("y", trio.id, "OWNER"), await person("z", trio.id, "OWNER")];
    const results = await Promise.all([y, z].map((target) => call(x, "PUT", `/v1/workspaces/members/${target.id}`, { role: "EDITOR" })));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await owner.query(`SELECT 1 FROM "Membership" WHERE "tenantId" = $1 AND role = 'OWNER'`, [trio.id])).rowCount).toBe(1);
  });

  it("el único Dueño de un espacio con más miembros tampoco puede irse; dejarse como Dueño es un no-op correcto", async () => {
    const crew = await createTestTenant("tripulacion");
    const boss = await person("capitana", crew.id, "OWNER");
    await person("marinero", crew.id, "EDITOR");
    await person("grumete", crew.id, "VIEWER");
    const denied = await call(boss, "PUT", `/v1/workspaces/members/${boss.id}`, { role: "EDITOR" });
    expect(denied.status).toBe(409);
    expect(await json(denied)).toMatchObject({ code: "last_owner" });
    expect((await call(boss, "DELETE", `/v1/workspaces/members/${boss.id}`)).status).toBe(409);
    expect((await call(boss, "PUT", `/v1/workspaces/members/${boss.id}`, { role: "OWNER" })).status).toBe(200);
  });

  it("no se quita a nadie su ÚNICO espacio (quedaría con 401 permanente): 409 con código propio", async () => {
    const lonely = await person("sin-otro-espacio", team.id, "EDITOR");
    const response = await call(ana, "DELETE", `/v1/workspaces/members/${lonely.id}`);
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: "last_membership" });
    expect(await roleOf(lonely.id)).toBe("EDITOR");
  });
});

describe("vista previa de una invitación (no consume nada)", () => {
  it("muestra a qué espacio y con qué rol, y el token sigue sirviendo después", async () => {
    const { token } = await invite(ana, "EDITOR");
    const guest = await stranger("curioso");
    for (let i = 0; i < 3; i += 1) {
      const response = await call(guest, "GET", `/v1/workspaces/invites/${token}`);
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ tenant: { id: team.id, name: expect.any(String) }, role: "EDITOR" });
    }
    expect(await roleOf(guest.id)).toBeUndefined(); // mirar no une a nadie
    expect((await owner.query(`SELECT 1 FROM "Invitation" WHERE "tokenHash" = $1 AND "acceptedAt" IS NULL`, [createHash("sha256").update(token).digest("base64url")])).rowCount).toBe(1);
    expect((await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(200);
  });

  it("sin sesión 401, con clave de API 403; desconocida 404; usada, vencida o revocada 410", async () => {
    const { token } = await invite(ana, "VIEWER");
    expect((await call(null, "GET", `/v1/workspaces/invites/${token}`)).status).toBe(401);
    expect((await call(null, "GET", `/v1/workspaces/invites/${token}`, undefined, { "x-api-key": team.apiKey })).status).toBe(403);

    const guest = await stranger("previsor");
    for (const bad of [`cfi_${randomBytes(32).toString("base64url")}`, "cfi_corto", "no-es-un-token"]) {
      expect((await call(guest, "GET", `/v1/workspaces/invites/${encodeURIComponent(bad)}`)).status, bad.slice(0, 12)).toBe(404);
    }
    const used = await invite(ana, "VIEWER");
    await call(guest, "POST", `/v1/workspaces/invites/${used.token}/accept`);
    const expired = await invite(ana, "VIEWER");
    await owner.query(`UPDATE "Invitation" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    const revoked = await invite(ana, "VIEWER");
    await call(ana, "DELETE", `/v1/workspaces/invites/${revoked.id}`);
    for (const gone of [used, expired, revoked]) expect((await call(guest, "GET", `/v1/workspaces/invites/${gone.token}`)).status).toBe(410);
  });
});

describe("consumo único del token: concurrencia y atomicidad", () => {
  it("la MISMA persona aceptando el mismo token a la vez: ambas peticiones reciben el mismo resultado", async () => {
    const { token } = await invite(ana, "EDITOR");
    const guest = await stranger("dos-pestañas");
    const results = await Promise.all([call(guest, "POST", `/v1/workspaces/invites/${token}/accept`), call(guest, "POST", `/v1/workspaces/invites/${token}/accept`)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await roleOf(guest.id)).toBe("EDITOR");
    const accepted = (await owner.query<{ acceptedBy: string }>(`SELECT "acceptedBy" FROM "Invitation" WHERE "tokenHash" = $1`, [createHash("sha256").update(token).digest("base64url")])).rows[0];
    expect(accepted?.acceptedBy).toBe(guest.id);
  });

  it("la misma persona con DOS tokens del mismo espacio a la vez: sin errores y con el mayor rol", async () => {
    const [low, high] = [await invite(ana, "VIEWER"), await invite(ana, "EDITOR")];
    const guest = await stranger("dos-tokens");
    const results = await Promise.all([low, high].map(({ token }) => call(guest, "POST", `/v1/workspaces/invites/${token}/accept`)));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await roleOf(guest.id)).toBe("EDITOR");
  });

  it("aceptar y revocar a la vez: o entra y la revocación es un no-op, o la revocación gana y no entra (nunca un estado a medias)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { token, id } = await invite(ana, "VIEWER");
      const guest = await stranger(`acepta-revoca-${round}`);
      const [accept, revoke] = await Promise.all([call(guest, "POST", `/v1/workspaces/invites/${token}/accept`), call(ana, "DELETE", `/v1/workspaces/invites/${id}`)]);
      expect(revoke.status).toBe(204);
      expect([200, 410]).toContain(accept.status);
      expect(await roleOf(guest.id) !== undefined, `ronda ${round}`).toBe(accept.status === 200);
    }
  });

  it("si algo falla DESPUÉS de reclamar el token, la transacción lo deshace: el token no se gasta y el reintento funciona", async () => {
    const { token } = await invite(ana, "VIEWER");
    const guest = await stranger("atomicidad");
    const hash = createHash("sha256").update(token).digest("base64url");
    const name = `fail_${guest.id.replaceAll("-", "")}`;
    await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo provocado por la prueba'; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "Membership" FOR EACH ROW WHEN (NEW."userId" = '${guest.id}') EXECUTE FUNCTION ${name}()`);
    try {
      expect((await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(500);
      expect((await owner.query(`SELECT 1 FROM "Invitation" WHERE "tokenHash" = $1 AND "acceptedAt" IS NULL AND "acceptedBy" IS NULL`, [hash])).rowCount, "el reclamo se deshizo").toBe(1);
      expect(await roleOf(guest.id)).toBeUndefined();
    } finally {
      await owner.query(`DROP TRIGGER ${name} ON "Membership"`);
      await owner.query(`DROP FUNCTION ${name}()`);
    }
    expect((await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`)).status).toBe(200);
    expect(await roleOf(guest.id)).toBe("VIEWER");
  });
});

describe("revocar y listar invitaciones", () => {
  it("un id que no es UUID es un 404, no un 500", async () => {
    for (const id of ["no-es-uuid", "123", "00000000-0000-0000-0000-00000000000g"]) {
      expect((await call(ana, "DELETE", `/v1/workspaces/invites/${id}`)).status, id).toBe(404);
    }
  });

  it("revocar una invitación ya usada no hace nada: la membresía sigue", async () => {
    const { token, id } = await invite(ana, "VIEWER");
    const guest = await stranger("usada-revocada");
    await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`);
    expect((await call(ana, "DELETE", `/v1/workspaces/invites/${id}`)).status).toBe(204);
    expect(await roleOf(guest.id)).toBe("VIEWER");
    expect((await owner.query(`SELECT 1 FROM "Invitation" WHERE id = $1 AND "revokedAt" IS NULL`, [id])).rowCount).toBe(1);
  });

  it("la lista no incluye las aceptadas, revocadas ni vencidas, y revocar la de otro espacio no la toca", async () => {
    const [pending, accepted, revoked, expired] = [await invite(ana, "VIEWER"), await invite(ana, "VIEWER"), await invite(ana, "VIEWER"), await invite(ana, "VIEWER")];
    await call(await stranger("lista-usa"), "POST", `/v1/workspaces/invites/${accepted.token}/accept`);
    await call(ana, "DELETE", `/v1/workspaces/invites/${revoked.id}`);
    await owner.query(`UPDATE "Invitation" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    const ids = (await json<{ invites: { id: string }[] }>(await call(ana, "GET", "/v1/workspaces/invites"))).invites.map((item) => item.id);
    expect(ids).toContain(pending.id);
    for (const gone of [accepted, revoked, expired]) expect(ids).not.toContain(gone.id);

    const elsewhere = await stranger("lista-ajena");
    const theirs = await invite(elsewhere, "VIEWER");
    expect((await call(ana, "DELETE", `/v1/workspaces/invites/${theirs.id}`)).status).toBe(404);
    expect((await owner.query(`SELECT 1 FROM "Invitation" WHERE id = $1 AND "revokedAt" IS NULL`, [theirs.id])).rowCount).toBe(1);
  });
});

describe("quien deja de ser Dueño no deja enlaces vivos", () => {
  it("al degradar o quitar a un Dueño se revocan sus invitaciones sin usar (las de otros Dueños siguen)", async () => {
    for (const how of ["degradar", "quitar"] as const) {
      const duo = await createTestTenant(`cascada-${how}`);
      const [boss, second] = [await person("jefa", duo.id, "OWNER"), await person("segundo", duo.id, "OWNER")];
      await owner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, 'OWNER')`, [second.id, (await createTestTenant(`propio-${how}`)).id]); // tiene otro espacio: se le puede quitar
      const [fromBoss, fromSecond] = [await invite(boss, "EDITOR"), await invite(second, "EDITOR")];
      const act = how === "degradar" ? call(boss, "PUT", `/v1/workspaces/members/${second.id}`, { role: "VIEWER" }) : call(boss, "DELETE", `/v1/workspaces/members/${second.id}`);
      expect((await act).status).toBeLessThan(300);
      const guest = await stranger(`cascada-guest-${how}`);
      expect((await call(guest, "POST", `/v1/workspaces/invites/${fromSecond.token}/accept`)).status, `${how}: la de quien cayó`).toBe(410);
      expect((await call(guest, "POST", `/v1/workspaces/invites/${fromBoss.token}/accept`)).status, `${how}: la del Dueño que sigue`).toBe(200);
    }
  });
});

describe("gestionar miembros (solo Dueño)", () => {
  it("lista a los miembros con su rol", async () => {
    const { members } = await json<{ members: { userId: string; name: string | null; role: string }[] }>(await call(ana, "GET", "/v1/workspaces/members"));
    const ids = members.map((m) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([ana.id, beto.id]));
    // Solo los de ESTE espacio: nadie de otro espacio aparece.
    const real = (await owner.query<{ userId: string }>(`SELECT "userId" FROM "Membership" WHERE "tenantId" = $1`, [team.id])).rows.map((row) => row.userId);
    expect([...ids].sort()).toEqual([...real].sort());
  });

  it("cambia roles; rechaza roles inventados, personas ajenas y cuerpos vacíos", async () => {
    expect((await call(ana, "PUT", `/v1/workspaces/members/${beto.id}`, { role: "VIEWER" })).status).toBe(200);
    expect(await roleOf(beto.id)).toBe("VIEWER");
    expect((await call(ana, "PUT", `/v1/workspaces/members/${beto.id}`, { role: "EDITOR" })).status).toBe(200);
    for (const body of [{ role: "ADMIN" }, {}, undefined]) {
      expect((await call(ana, "PUT", `/v1/workspaces/members/${beto.id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
    // Alguien que NO es de este espacio: 404 (nunca se toca otro espacio).
    const outsider = await stranger("ajeno");
    expect((await call(ana, "PUT", `/v1/workspaces/members/${outsider.id}`, { role: "VIEWER" })).status).toBe(404);
    expect((await call(ana, "DELETE", `/v1/workspaces/members/${outsider.id}`)).status).toBe(404);
    expect(await roleOf(outsider.id, outsider.tenantId)).toBe("OWNER");
  });

  it("expulsar a alguien le quita el acceso a este espacio en su siguiente petición", async () => {
    const { token } = await invite(ana, "EDITOR");
    const guest = await stranger("expulsado");
    await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`);
    expect((await call(guest, "POST", "/v1/me/workspace", { tenantId: team.id })).status).toBe(200);
    expect((await json<{ tenant: { id: string } }>(await call(guest, "GET", "/v1/me"))).tenant.id).toBe(team.id);

    expect((await call(ana, "DELETE", `/v1/workspaces/members/${guest.id}`)).status).toBe(204);
    expect(await roleOf(guest.id)).toBeUndefined();
    // Su sesión apuntaba a este espacio; ya no es miembro, así que vuelve a su espacio propio y no conserva nada de aquí.
    expect((await json<{ tenant: { id: string } }>(await call(guest, "GET", "/v1/me"))).tenant.id).toBe(guest.tenantId);
  });
});

describe("espacios de una persona y cambio de espacio activo", () => {
  it("lista sus espacios con el rol en cada uno y marca el activo; cambiar exige ser miembro", async () => {
    const { token } = await invite(ana, "VIEWER");
    const guest = await stranger("viajera");
    await call(guest, "POST", `/v1/workspaces/invites/${token}/accept`);

    const before = await json<{ workspaces: { id: string; role: string; active: boolean }[] }>(await call(guest, "GET", "/v1/workspaces"));
    expect(before.workspaces.map((w) => [w.id, w.role, w.active]).sort()).toEqual([[guest.tenantId, "OWNER", true], [team.id, "VIEWER", false]].sort());

    expect((await call(guest, "POST", "/v1/me/workspace", { tenantId: team.id })).status).toBe(200);
    const me = await json<{ tenant: { id: string }; role: string }>(await call(guest, "GET", "/v1/me"));
    expect(me).toMatchObject({ tenant: { id: team.id }, role: "VIEWER" });
    const after = await json<{ workspaces: { id: string; active: boolean }[] }>(await call(guest, "GET", "/v1/workspaces"));
    expect(after.workspaces.find((w) => w.active)?.id).toBe(team.id);

    // Un espacio donde no es miembro, o un valor que no es un UUID: no se cambia nada.
    const foreign = await createTestTenant("ajeno-total");
    expect((await call(guest, "POST", "/v1/me/workspace", { tenantId: foreign.id })).status).toBe(404);
    expect((await call(guest, "POST", "/v1/me/workspace", { tenantId: "no-es-uuid" })).status).toBe(400);
    expect((await call(guest, "POST", "/v1/me/workspace", {})).status).toBe(400);
    expect((await json<{ tenant: { id: string } }>(await call(guest, "GET", "/v1/me"))).tenant.id).toBe(team.id);
  });

  it("una clave de API no tiene espacios que cambiar (403)", async () => {
    expect((await call(null, "POST", "/v1/me/workspace", { tenantId: team.id }, { "x-api-key": team.apiKey })).status).toBe(403);
    expect((await call(null, "GET", "/v1/workspaces", undefined, { "x-api-key": team.apiKey })).status).toBe(403);
  });
});
