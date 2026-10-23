import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INVITE_KEY } from "../public/js/api/invite.js";
import { acceptPendingInvite, checkPendingInvite } from "../public/js/api/join.js";

const TOKEN = `cfi_${"c".repeat(43)}`;
const TEAM = { id: "33333333-3333-4333-8333-333333333333", name: "Equipo Ana" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key), data };
};

/** Un fetch que responde por «MÉTODO ruta» y apunta cada llamada; lo no previsto es un error de red. */
function server(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    calls.push(key);
    const handler = routes[key];
    if (handler === undefined) throw new TypeError(`ruta no prevista: ${key}`);
    return handler();
  };
  return { calls, fetchImpl };
}

const PREVIEW = `GET /v1/workspaces/invites/${TOKEN}`;
const ACCEPT = `POST /v1/workspaces/invites/${TOKEN}/accept`;
const SWITCH = "POST /v1/me/workspace";
const base = { baseUrl: "", token: TOKEN };

describe("comprobar la invitación pendiente (nunca consume)", () => {
  it("sin invitación no llama a nada", async () => {
    const { calls, fetchImpl } = server({});
    assert.deepEqual(await checkPendingInvite({ ...base, token: null, access: { mode: "session" }, storage: memoryStorage(), fetchImpl }), { state: "none" });
    assert.deepEqual(calls, []);
  });

  it("con sesión pide la vista previa y devuelve «confirmar» SIN aceptar ni cambiar de espacio", async () => {
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    const { calls, fetchImpl } = server({ [PREVIEW]: () => json({ tenant: TEAM, role: "EDITOR" }) });
    const result = await checkPendingInvite({ ...base, access: { mode: "session" }, storage, fetchImpl });
    assert.deepEqual(result, { state: "confirm", token: TOKEN, preview: { tenant: TEAM, role: "EDITOR" } });
    assert.deepEqual(calls, [PREVIEW]);
    assert.equal(storage.data.get(INVITE_KEY), TOKEN, "el token sigue guardado hasta que la persona decida");
  });

  it("sin sesión (login o error) conserva el token para el viaje de inicio de sesión y no llama a nada", async () => {
    for (const mode of ["login", "none", "error"]) {
      const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
      const { calls, fetchImpl } = server({});
      assert.deepEqual(await checkPendingInvite({ ...base, access: { mode }, storage, fetchImpl }), { state: "none" }, mode);
      assert.deepEqual(calls, [], mode);
      assert.equal(storage.data.get(INVITE_KEY), TOKEN, mode);
    }
  });

  it("instalación local (clave): no hay equipos, se limpia el token y se avisa", async () => {
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    const { calls, fetchImpl } = server({});
    assert.deepEqual(await checkPendingInvite({ ...base, access: { mode: "key" }, storage, fetchImpl }), { state: "unavailable" });
    assert.deepEqual(calls, []);
    assert.equal(storage.data.size, 0);
  });

  it("404 y 410 son definitivos: se borra el token. Un fallo pasajero (503, red) lo CONSERVA para reintentar", async () => {
    for (const status of [404, 410, 400]) {
      const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
      const { fetchImpl } = server({ [PREVIEW]: () => json({ statusCode: status }, status) });
      assert.deepEqual(await checkPendingInvite({ ...base, access: { mode: "session" }, storage, fetchImpl }), { state: "gone" }, String(status));
      assert.equal(storage.data.size, 0, String(status));
    }
    for (const handler of [() => json({ statusCode: 503 }, 503), () => json({ statusCode: 429 }, 429), () => json({ statusCode: 500 }, 500), () => json({ statusCode: 401 }, 401)]) {
      const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
      const { fetchImpl } = server({ [PREVIEW]: handler });
      assert.deepEqual(await checkPendingInvite({ ...base, access: { mode: "session" }, storage, fetchImpl }), { state: "unreachable" });
      assert.equal(storage.data.get(INVITE_KEY), TOKEN);
    }
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    assert.deepEqual(await checkPendingInvite({ ...base, access: { mode: "session" }, storage, fetchImpl: server({}).fetchImpl }), { state: "unreachable" }, "red caída");
    assert.equal(storage.data.get(INVITE_KEY), TOKEN);
  });
});

describe("aceptar tras el clic explícito", () => {
  it("acepta, luego abre el espacio, y borra el token", async () => {
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    const { calls, fetchImpl } = server({ [ACCEPT]: () => json({ tenant: TEAM, role: "EDITOR" }), [SWITCH]: () => json({ tenant: TEAM, role: "EDITOR" }) });
    assert.deepEqual(await acceptPendingInvite({ ...base, storage, fetchImpl }), { outcome: "joined", tenant: TEAM, role: "EDITOR", switched: true });
    assert.deepEqual(calls, [ACCEPT, SWITCH], "primero aceptar, después cambiar de espacio");
    assert.equal(storage.data.size, 0);
  });

  it("aceptar sale bien pero abrir el espacio falla: la persona YA es miembro, no se dice «invitación fallida»", async () => {
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    const { fetchImpl } = server({ [ACCEPT]: () => json({ tenant: TEAM, role: "VIEWER" }), [SWITCH]: () => json({ statusCode: 503 }, 503) });
    assert.deepEqual(await acceptPendingInvite({ ...base, storage, fetchImpl }), { outcome: "joined", tenant: TEAM, role: "VIEWER", switched: false });
    assert.equal(storage.data.size, 0, "el token ya se gastó: no se repite");
  });

  it("410/404 al aceptar: definitivo, se borra el token y no se intenta cambiar de espacio", async () => {
    for (const status of [410, 404]) {
      const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
      const { calls, fetchImpl } = server({ [ACCEPT]: () => json({ statusCode: status }, status) });
      assert.deepEqual(await acceptPendingInvite({ ...base, storage, fetchImpl }), { outcome: "gone" });
      assert.deepEqual(calls, [ACCEPT]);
      assert.equal(storage.data.size, 0);
    }
  });

  it("un fallo pasajero al aceptar (5xx, 429, 401, red) CONSERVA el token: el servidor lo deshizo o no lo vio", async () => {
    for (const handler of [() => json({}, 500), () => json({}, 503), () => json({}, 429), () => json({}, 401), () => { throw new TypeError("red"); }]) {
      const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
      const { calls, fetchImpl } = server({ [ACCEPT]: handler });
      assert.deepEqual(await acceptPendingInvite({ ...base, storage, fetchImpl }), { outcome: "retry" });
      assert.deepEqual(calls, [ACCEPT]);
      assert.equal(storage.data.get(INVITE_KEY), TOKEN);
    }
  });
});
