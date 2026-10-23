import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INVITE_KEY, brokenInviteInUrl, captureInvite, clearInvite, pendingInvite, rememberJoined, takeJoined } from "../public/js/api/invite.js";
import { errorFromResponse } from "../public/js/api/errors.js";
import { acceptInvite, createInvite, listInvites, listMembers, listWorkspaces, previewInvite, removeMember, revokeInvite, setMemberRole, switchWorkspace } from "../public/js/api/workspaces.js";
import { messages } from "../public/js/i18n/messages.js";

const TOKEN = `cfi_${"b".repeat(43)}`;
const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key), data };
};
const fakeWindow = (search, hash = "") => {
  const replaced = [];
  return { location: { search, pathname: "/", hash }, history: { replaceState: (_state, _title, url) => replaced.push(url) }, replaced };
};

describe("captura de la invitación (api/invite.js)", () => {
  it("guarda el token de ?invite=, lo quita de la barra de direcciones y conserva el resto de la consulta", () => {
    const storage = memoryStorage();
    const win = fakeWindow(`?invite=${TOKEN}&login_error=denied`, "#x");
    assert.equal(captureInvite(win, storage), TOKEN);
    assert.equal(storage.data.get(INVITE_KEY), TOKEN);
    assert.deepEqual(win.replaced, ["/?login_error=denied#x"]);
  });

  it("sin más parámetros deja la URL limpia", () => {
    const win = fakeWindow(`?invite=${TOKEN}`);
    captureInvite(win, memoryStorage());
    assert.deepEqual(win.replaced, ["/"]);
  });

  it("un valor que no tiene la forma de un token no se guarda (pero igualmente se quita de la URL)", () => {
    for (const bad of ["", "cfi_corto", "<script>", `cfi_${"b".repeat(80)}`, "otro_" + "b".repeat(43)]) {
      const storage = memoryStorage();
      const win = fakeWindow(`?invite=${encodeURIComponent(bad)}`);
      assert.equal(captureInvite(win, storage), null, bad);
      assert.equal(storage.data.size, 0, bad);
      assert.equal(win.replaced.length, 1, bad);
    }
  });

  it("una invitación guardada antes (el viaje a GitHub) sigue pendiente al volver sin ?invite=", () => {
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    assert.equal(captureInvite(fakeWindow(""), storage), TOKEN);
    assert.equal(pendingInvite(storage), TOKEN);
  });

  it("clearInvite la borra; un valor corrupto guardado se ignora", () => {
    const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
    clearInvite(storage);
    assert.equal(pendingInvite(storage), null);
    assert.equal(pendingInvite(memoryStorage({ [INVITE_KEY]: "basura" })), null);
  });

  it("sin almacenamiento (modo privado) la invitación sigue valiendo en ESTA carga aunque no se pueda guardar", () => {
    const blocked = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => { throw new Error("bloqueado"); } };
    for (const storage of [null, blocked]) {
      const win = fakeWindow(`?invite=${TOKEN}`);
      assert.equal(captureInvite(win, storage), TOKEN);
      assert.deepEqual(win.replaced, ["/"], "el token sale de la barra de direcciones igualmente");
    }
    clearInvite(blocked);
    assert.equal(pendingInvite(blocked), null);
  });

  it("la URL se limpia ANTES de guardar: si guardar falla, el token no se queda en la barra de direcciones", () => {
    const order = [];
    const win = { location: { search: `?invite=${TOKEN}`, pathname: "/", hash: "" }, history: { replaceState: () => order.push("limpiar") } };
    captureInvite(win, { getItem: () => null, setItem: () => { order.push("guardar"); throw new Error("bloqueado"); }, removeItem() {} });
    assert.deepEqual(order, ["limpiar", "guardar"]);
  });

  it("un enlace cortado se detecta para avisar (brokenInviteInUrl) y no se guarda", () => {
    assert.equal(brokenInviteInUrl({ location: { search: "?invite=cfi_corto" } }), true);
    assert.equal(brokenInviteInUrl({ location: { search: `?invite=${TOKEN}` } }), false);
    assert.equal(brokenInviteInUrl({ location: { search: "" } }), false);
  });

  it("el aviso «te uniste a X» sobrevive a la recarga una sola vez, y un valor raro se ignora", () => {
    const session = memoryStorage();
    rememberJoined(session, { name: "Equipo Ana", role: "EDITOR" });
    assert.deepEqual(takeJoined(session), { name: "Equipo Ana", role: "EDITOR" });
    assert.equal(takeJoined(session), null);
    session.setItem("cf_joined", "{\"name\":1}");
    assert.equal(takeJoined(session), null);
    session.setItem("cf_joined", "no es json");
    assert.equal(takeJoined(session), null);
    assert.equal(takeJoined(null), null);
  });
});

describe("API de equipos (api/workspaces.js)", () => {
  const record = () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body === undefined ? undefined : JSON.parse(init.body) });
      return new Response(init.method === "DELETE" ? null : JSON.stringify({ members: [], tenant: { id: "t", name: "n" }, role: "VIEWER", link: "l" }), { status: init.method === "DELETE" ? 204 : 200, headers: { "content-type": "application/json" } });
    };
    return { calls, fetchImpl };
  };

  it("usa los métodos y rutas del servidor, con el token y los ids codificados en la ruta", async () => {
    const { calls, fetchImpl } = record();
    await listMembers({ baseUrl: "", fetchImpl });
    await setMemberRole({ baseUrl: "", userId: "u 1", role: "VIEWER", fetchImpl });
    await removeMember({ baseUrl: "", userId: "u/2", fetchImpl });
    await createInvite({ baseUrl: "", role: "EDITOR", fetchImpl });
    await revokeInvite({ baseUrl: "", id: "i1", fetchImpl });
    await previewInvite({ baseUrl: "", token: "cfi_x/y", fetchImpl });
    await acceptInvite({ baseUrl: "", token: "cfi_x/y", fetchImpl });
    await switchWorkspace({ baseUrl: "", tenantId: "t1", fetchImpl });
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /v1/workspaces/members",
        "PUT /v1/workspaces/members/u%201",
        "DELETE /v1/workspaces/members/u%2F2",
        "POST /v1/workspaces/invites",
        "DELETE /v1/workspaces/invites/i1",
        "GET /v1/workspaces/invites/cfi_x%2Fy",
        "POST /v1/workspaces/invites/cfi_x%2Fy/accept",
        "POST /v1/me/workspace",
      ],
    );
    assert.deepEqual(calls[1].body, { role: "VIEWER" });
    assert.deepEqual(calls[7].body, { tenantId: "t1" });
  });

  it("una respuesta mal formada es un error, no una lista vacía que parezca «sin miembros»", async () => {
    const broken = async () => new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "content-type": "application/json" } });
    for (const call of [listMembers, listInvites, listWorkspaces]) {
      await assert.rejects(call({ baseUrl: "", fetchImpl: broken }), (error) => error.code === "bad_response");
    }
  });
});

describe("errores de equipos", () => {
  it("un 403 con code role_forbidden es el rol; cualquier otro 403 sigue siendo «no autorizada»", () => {
    assert.equal(errorFromResponse(403, JSON.stringify({ statusCode: 403, code: "role_forbidden", message: "x" }), null).code, "role_forbidden");
    assert.equal(errorFromResponse(403, JSON.stringify({ statusCode: 403, message: "x" }), null).code, "forbidden");
    assert.equal(errorFromResponse(403, "<html>", null).code, "forbidden");
  });

  it("un 409 con code estable se distingue (último Dueño, tope de invitaciones, único espacio); sin code sigue siendo «conflict»", () => {
    for (const code of ["last_owner", "invite_limit", "last_membership"]) {
      assert.equal(errorFromResponse(409, JSON.stringify({ statusCode: 409, code, message: "x" }), null).code, code);
    }
    assert.equal(errorFromResponse(409, JSON.stringify({ statusCode: 409, message: "x" }), null).code, "conflict");
    assert.equal(errorFromResponse(409, JSON.stringify({ statusCode: 409, code: "inventado" }), null).code, "conflict");
    assert.equal(errorFromResponse(403, JSON.stringify({ code: "last_owner" }), null).code, "forbidden");
  });

  it("410 es «ese enlace ya no sirve»", () => {
    assert.equal(errorFromResponse(410, JSON.stringify({ statusCode: 410 }), null).code, "gone");
  });

  it("ambos códigos tienen texto en todos los idiomas", () => {
    const keys = ["error.role_forbidden", "error.gone", "invite.confirm.title", "invite.confirm.body", "invite.confirm.join", "invite.confirm.decline", "invite.confirm.continue", "invite.confirm.retry", "invite.confirm.noSwitch", "invite.unreachable", "invite.unavailable", "invite.broken", "team.error.inviteLimit", "team.error.lastMembership"];
    for (const lang of Object.keys(messages)) for (const key of keys) assert.ok(messages[lang][key], `${lang} ${key}`);
  });
});
