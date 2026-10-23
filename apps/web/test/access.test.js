import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createKey, getMe, getProviders, listKeys, logout, revokeKey } from "../public/js/api/account.js";
import { resolveAccess } from "../public/js/api/access.js";
import { authHeaders, setApiKey, setSessionMode } from "../public/js/api/auth.js";

const KEY = `cfk_${"c".repeat(64)}`;
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const ME = { tenant: { id: "t1", name: "Ana" }, user: { name: "Ana", email: "ana@example.com", provider: "github" } };

afterEach(() => {
  setApiKey("");
  setSessionMode(false);
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status, code = "x") => json({ statusCode: status, error: code }, status);

/** fetch falso por ruta; registra cada llamada */
function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const handler = routes[url];
    if (!handler) throw new TypeError(`ruta no prevista: ${url}`);
    return handler(init);
  };
  return { fetchImpl, calls };
}

describe("modo sesión (api/auth.js)", () => {
  it("sin clave y sin modo sesión no manda cabeceras; en modo sesión manda la cabecera anti-CSRF", () => {
    assert.deepEqual(authHeaders(), {});
    setSessionMode(true);
    assert.deepEqual(authHeaders(), { "X-Requested-With": "captionforge" });
  });

  it("con clave de API manda la clave y no la cabecera de sesión", () => {
    setSessionMode(true);
    setApiKey(KEY);
    assert.deepEqual(authHeaders(), { "X-API-Key": KEY });
  });
});

describe("api/account.js", () => {
  it("getProviders devuelve solo proveedores conocidos y nunca lanza", async () => {
    const ok = router({ "/auth/providers": () => json({ providers: ["github", "google", "evil"], localMode: false }) });
    assert.deepEqual(await getProviders({ baseUrl: "", fetchImpl: ok.fetchImpl }), ["github", "google"]);
    const broken = router({ "/auth/providers": () => problem(500) });
    assert.deepEqual(await getProviders({ baseUrl: "", fetchImpl: broken.fetchImpl }), []);
    assert.deepEqual(await getProviders({ baseUrl: "", fetchImpl: async () => { throw new TypeError("sin red"); } }), []);
  });

  it("getMe valida la forma y lanza unauthorized sin sesión", async () => {
    const ok = router({ "/v1/me": () => json(ME) });
    assert.deepEqual(await getMe({ baseUrl: "", fetchImpl: ok.fetchImpl }), ME);
    const nope = router({ "/v1/me": () => problem(401, "Unauthorized") });
    await assert.rejects(getMe({ baseUrl: "", fetchImpl: nope.fetchImpl }), { code: "unauthorized" });
    const odd = router({ "/v1/me": () => json({ nada: 1 }) });
    await assert.rejects(getMe({ baseUrl: "", fetchImpl: odd.fetchImpl }), TypeError);
  });

  it("crear, listar y revocar usan los métodos y rutas correctos, con la cabecera anti-CSRF en modo sesión", async () => {
    setSessionMode(true);
    const { fetchImpl, calls } = router({
      "/v1/keys": (init) => (init.method === "POST" ? json({ id: KEY_ID, name: "script", prefix: "cfk_abcd", key: KEY, createdAt: "2026-10-22T00:00:00Z", lastUsedAt: null, revokedAt: null }, 201) : json({ keys: [] })),
      [`/v1/keys/${KEY_ID}`]: () => new Response(null, { status: 204 }),
      "/auth/logout": () => new Response(null, { status: 204 }),
    });
    assert.deepEqual(await listKeys({ baseUrl: "", fetchImpl }), []);
    const created = await createKey({ baseUrl: "", name: "script", fetchImpl });
    assert.equal(created.key, KEY);
    assert.equal(JSON.parse(calls[1].body).name, "script");
    await revokeKey({ baseUrl: "", id: KEY_ID, fetchImpl });
    await logout({ baseUrl: "", fetchImpl });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET /v1/keys", "POST /v1/keys", `DELETE /v1/keys/${KEY_ID}`, "POST /auth/logout"]);
    for (const call of calls) assert.equal(call.headers["X-Requested-With"], "captionforge", call.url);
  });

  it("revokeKey rechaza un id que no parece un UUID sin tocar la red", async () => {
    await assert.rejects(revokeKey({ baseUrl: "", id: "../../x", fetchImpl: async () => assert.fail("no debía pedir") }), TypeError);
  });
});

describe("resolveAccess", () => {
  const webConfig = (body, status = 200) => () => (status === 200 ? json(body) : problem(status));

  it("con clave por defecto del servidor entra en modo key sin preguntar por sesión", async () => {
    const { fetchImpl, calls } = router({ "/web-config.json": webConfig({ apiKey: KEY }) });
    assert.deepEqual(await resolveAccess({ baseUrl: "", fetchImpl }), { mode: "key", providers: [], me: null });
    assert.deepEqual(calls.map((c) => c.url), ["/web-config.json"]);
  });

  it("sin clave y con sesión iniciada entra en modo session", async () => {
    const { fetchImpl } = router({
      "/web-config.json": webConfig({}, 404),
      "/auth/providers": () => json({ providers: ["github"], localMode: false }),
      "/v1/me": () => json(ME),
    });
    assert.deepEqual(await resolveAccess({ baseUrl: "", fetchImpl }), { mode: "session", providers: ["github"], me: ME });
    assert.deepEqual(authHeaders(), { "X-Requested-With": "captionforge" });
  });

  it("sin sesión pide entrar si hay proveedores, y avisa si no hay ninguno", async () => {
    const base = { "/web-config.json": webConfig({}, 404), "/v1/me": () => problem(401, "Unauthorized") };
    const withProviders = router({ ...base, "/auth/providers": () => json({ providers: ["github", "google"], localMode: false }) });
    assert.equal((await resolveAccess({ baseUrl: "", fetchImpl: withProviders.fetchImpl })).mode, "login");
    assert.deepEqual(authHeaders(), {}, "sin sesión no queda el modo sesión activo");
    const none = router({ ...base, "/auth/providers": () => json({ providers: [], localMode: false }) });
    assert.equal((await resolveAccess({ baseUrl: "", fetchImpl: none.fetchImpl })).mode, "none");
  });

  it("si el servidor no responde, modo error (no se hace pasar por pantalla de entrada vacía)", async () => {
    const { fetchImpl } = router({
      "/web-config.json": webConfig({}, 404),
      "/auth/providers": () => json({ providers: ["github"], localMode: false }),
      "/v1/me": () => problem(503, "busy"),
    });
    assert.equal((await resolveAccess({ baseUrl: "", fetchImpl })).mode, "error");
  });
});
