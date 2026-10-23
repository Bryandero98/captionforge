import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INVITE_KEY } from "../public/js/api/invite.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createInviteConfirm } from "../public/js/ui/invite-confirm.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const TOKEN = `cfi_${"d".repeat(43)}`;
const TEAM = { id: "33333333-3333-4333-8333-333333333333", name: "Equipo Ana" };
const IDS = ["invite-confirm", "invite-confirm-title", "invite-confirm-body", "invite-confirm-status", "invite-confirm-join", "invite-confirm-decline", "invite-confirm-continue"];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key), data };
};

function setup({ routes = {}, role = "EDITOR", modal = true } = {}) {
  const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  const dialog = elements["invite-confirm"];
  dialog.hidden = true;
  dialog.open = false;
  dialog.shown = 0;
  if (modal) {
    dialog.showModal = () => { dialog.open = true; dialog.shown += 1; };
    dialog.close = () => { dialog.open = false; };
  }
  elements["invite-confirm-continue"].hidden = true;
  const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null };
  const win = { location: { reload: () => (win.reloaded = true) }, reloaded: false };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    calls.push(key);
    const handler = routes[key];
    if (handler === undefined) throw new TypeError(`ruta no prevista: ${key}`);
    return handler();
  };
  const storage = memoryStorage({ [INVITE_KEY]: TOKEN });
  const session = memoryStorage();
  const confirm = createInviteConfirm({ doc, win, baseUrl: "", token: TOKEN, preview: { tenant: TEAM, role }, storage, session, t, fetchImpl });
  return { elements, dialog, win, calls, storage, session, confirm };
}

const ACCEPT = `POST /v1/workspaces/invites/${TOKEN}/accept`;
const SWITCH = "POST /v1/me/workspace";

describe("pantalla de confirmación de una invitación", () => {
  it("se abre como diálogo modal y dice a qué espacio y con qué rol, sin llamar a nada hasta el clic", () => {
    const { elements, dialog, calls } = setup({ role: "VIEWER" });
    assert.equal(dialog.open, true);
    assert.equal(elements["invite-confirm-title"].textContent, t("invite.confirm.title"));
    assert.equal(elements["invite-confirm-body"].textContent, t("invite.confirm.body", { name: "Equipo Ana", role: "Lector" }));
    assert.match(elements["invite-confirm-body"].textContent, /Equipo Ana/);
    assert.match(elements["invite-confirm-body"].textContent, /Lector/);
    assert.equal(elements["invite-confirm-join"].hidden, false);
    assert.equal(elements["invite-confirm-decline"].hidden, false);
    assert.equal(elements["invite-confirm-continue"].hidden, true);
    assert.deepEqual(calls, [], "abrir la pantalla NO acepta nada");
  });

  it("sin <dialog> nativo se muestra quitando hidden", () => {
    const { dialog } = setup({ modal: false });
    assert.equal(dialog.hidden, false);
  });

  it("«Unirme» acepta, abre el espacio, deja el aviso para después de la recarga y recarga", async () => {
    const { elements, calls, win, session, storage } = setup({ routes: { [ACCEPT]: () => json({ tenant: TEAM, role: "EDITOR" }), [SWITCH]: () => json({ tenant: TEAM, role: "EDITOR" }) } });
    elements["invite-confirm-join"].fire("click");
    assert.equal(elements["invite-confirm-join"].disabled, true, "se deshabilita mientras trabaja: sin doble clic");
    await flush();
    await flush();
    assert.deepEqual(calls, [ACCEPT, SWITCH]);
    assert.equal(win.reloaded, true);
    assert.deepEqual(JSON.parse(session.data.get("cf_joined")), { name: "Equipo Ana", role: "EDITOR" });
    assert.equal(storage.data.size, 0);
  });

  it("«Ahora no» (y Esc) borra el token y cierra, sin tocar la red", () => {
    for (const how of ["decline", "cancel"]) {
      const { elements, dialog, calls, storage } = setup();
      (how === "decline" ? elements["invite-confirm-decline"] : dialog).fire(how === "decline" ? "click" : "cancel");
      assert.equal(dialog.open, false, how);
      assert.deepEqual(calls, [], how);
      assert.equal(storage.data.size, 0, how);
    }
  });

  it("un fallo pasajero deja el token, avisa y permite reintentar", async () => {
    const { elements, storage, win } = setup({ routes: { [ACCEPT]: () => json({ statusCode: 503 }, 503) } });
    elements["invite-confirm-join"].fire("click");
    await flush();
    await flush();
    assert.equal(elements["invite-confirm-status"].textContent, t("invite.confirm.retry"));
    assert.equal(elements["invite-confirm-join"].disabled, false);
    assert.equal(elements["invite-confirm-join"].hidden, false);
    assert.equal(storage.data.get(INVITE_KEY), TOKEN);
    assert.equal(win.reloaded, false);
  });

  it("410: explica que el enlace ya no sirve y ofrece «Continuar» (cierra, sin recargar)", async () => {
    const { elements, dialog, win, storage } = setup({ routes: { [ACCEPT]: () => json({ statusCode: 410 }, 410) } });
    elements["invite-confirm-join"].fire("click");
    await flush();
    await flush();
    assert.equal(elements["invite-confirm-status"].textContent, t("invite.failed"));
    assert.equal(elements["invite-confirm-join"].hidden, true);
    assert.equal(elements["invite-confirm-continue"].hidden, false);
    assert.equal(storage.data.size, 0);
    elements["invite-confirm-continue"].fire("click");
    assert.equal(dialog.open, false);
    assert.equal(win.reloaded, false);
  });

  it("se unió pero no se pudo abrir el espacio: lo dice (no «fallida») y «Continuar» recarga", async () => {
    const { elements, win } = setup({ routes: { [ACCEPT]: () => json({ tenant: TEAM, role: "EDITOR" }), [SWITCH]: () => json({ statusCode: 503 }, 503) } });
    elements["invite-confirm-join"].fire("click");
    await flush();
    await flush();
    assert.equal(elements["invite-confirm-status"].textContent, t("invite.confirm.noSwitch", { name: "Equipo Ana" }));
    assert.equal(win.reloaded, false);
    elements["invite-confirm-continue"].fire("click");
    assert.equal(win.reloaded, true);
  });

  it("el nombre del espacio entra como texto, nunca como HTML", () => {
    const hostile = { tenant: { id: TEAM.id, name: "<img src=x onerror=alert(1)>" }, role: "EDITOR" };
    const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
    const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null };
    createInviteConfirm({ doc, win: { location: {} }, baseUrl: "", token: TOKEN, preview: hostile, storage: memoryStorage(), session: memoryStorage(), t });
    assert.match(elements["invite-confirm-body"].textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(elements["invite-confirm-body"].children.length, 0);
  });
});
