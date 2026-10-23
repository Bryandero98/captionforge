import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setSessionMode } from "../public/js/api/auth.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createTeam } from "../public/js/ui/team.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const ME_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ACCESS = { mode: "session", providers: [], me: { tenant: { id: TEAM_ID, name: "Equipo" }, role: "OWNER", user: { id: ME_ID, name: "Ana", email: null, provider: "github" } } };
const members = () => [
  { userId: ME_ID, name: "Ana", email: null, provider: "github", role: "OWNER", joinedAt: "2026-10-01T00:00:00Z" },
  { userId: OTHER_ID, name: "Beto", email: null, provider: "github", role: "EDITOR", joinedAt: "2026-10-02T00:00:00Z" },
];

afterEach(() => setSessionMode(false));

const IDS = ["workspace-select", "account-team-toggle", "team-panel", "team-members", "team-problem", "team-invite-form", "team-invite-role", "team-link-box", "team-link", "team-copy", "team-invites", "team-invites-empty"];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ access = OWNER_ACCESS, routes = {} } = {}) {
  const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  elements["team-panel"].hidden = true;
  elements["team-link-box"].hidden = true;
  const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const clipboard = [];
  const win = { navigator: { clipboard: { writeText: async (text) => clipboard.push(text) } }, location: { reload: () => (win.reloaded = true) }, reloaded: false };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const handler = routes[key];
    if (!handler) throw new TypeError(`ruta no prevista: ${key}`);
    return handler(init);
  };
  const announced = [];
  const team = createTeam({ doc, win, baseUrl: "", access, t, announce: (text) => announced.push(text), fetchImpl });
  return { elements, team, win, calls, clipboard, announced };
}

const ownerRoutes = (extra = {}) => ({
  "GET /v1/workspaces": () => json({ workspaces: [] }),
  "GET /v1/workspaces/members": () => json({ members: members() }),
  "GET /v1/workspaces/invites": () => json({ invites: [] }),
  ...extra,
});

describe("selector de espacio de trabajo", () => {
  it("con un solo espacio no se muestra; con varios lista nombre y rol y marca el activo", async () => {
    setSessionMode(true);
    const one = setup({ routes: { "GET /v1/workspaces": () => json({ workspaces: [{ id: TEAM_ID, name: "Solo", role: "OWNER", active: true }] }) } });
    await flush();
    assert.equal(one.elements["workspace-select"].hidden, true);

    const many = setup({ routes: { "GET /v1/workspaces": () => json({ workspaces: [{ id: TEAM_ID, name: "Equipo", role: "OWNER", active: false }, { id: OTHER_ID, name: "Personal", role: "VIEWER", active: true }] }) } });
    await flush();
    const select = many.elements["workspace-select"];
    assert.equal(select.hidden, false);
    assert.deepEqual(select.children.map((option) => option.textContent), ["Equipo · Dueño", "Personal · Lector"]);
    assert.equal(select.value, OTHER_ID);
  });

  it("elegir otro espacio lo cambia en el servidor y recarga la página", async () => {
    setSessionMode(true);
    const { elements, calls, win } = setup({
      routes: {
        "GET /v1/workspaces": () => json({ workspaces: [{ id: TEAM_ID, name: "A", role: "OWNER", active: true }, { id: OTHER_ID, name: "B", role: "EDITOR", active: false }] }),
        "POST /v1/me/workspace": () => json({ tenant: { id: OTHER_ID, name: "B" }, role: "EDITOR" }),
      },
    });
    await flush();
    elements["workspace-select"].value = OTHER_ID;
    elements["workspace-select"].fire("change");
    await flush();
    assert.deepEqual(calls.at(-1), { key: "POST /v1/me/workspace", body: { tenantId: OTHER_ID } });
    assert.equal(win.reloaded, true);
  });

  it("si cambiar de espacio falla, el selector vuelve al activo y se AVISA (aunque no sea Dueño y no tenga panel de equipo)", async () => {
    setSessionMode(true);
    const notified = [];
    const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
    elements["team-panel"].hidden = true;
    elements["team-link-box"].hidden = true;
    const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
    const win = { navigator: {}, location: { reload: () => (win.reloaded = true) }, reloaded: false };
    const viewer = { ...OWNER_ACCESS, me: { ...OWNER_ACCESS.me, role: "VIEWER" } };
    const fetchImpl = async (url, init = {}) => {
      if (`${init.method ?? "GET"} ${url}` === "GET /v1/workspaces") return json({ workspaces: [{ id: TEAM_ID, name: "A", role: "VIEWER", active: true }, { id: OTHER_ID, name: "B", role: "VIEWER", active: false }] });
      return json({ statusCode: 503 }, 503);
    };
    createTeam({ doc, win, baseUrl: "", access: viewer, t, notify: (text) => notified.push(text), fetchImpl });
    await flush();
    elements["workspace-select"].value = OTHER_ID;
    elements["workspace-select"].fire("change");
    await flush();
    await flush();
    assert.equal(win.reloaded, false);
    assert.equal(elements["workspace-select"].value, TEAM_ID, "vuelve al espacio que sigue activo");
    assert.deepEqual(notified, [t("error.busy", { seconds: 10 })]);
  });

  it("sin sesión (clave local) no pide ningún espacio", async () => {
    const { calls } = setup({ access: { mode: "key", providers: [], me: null } });
    await flush();
    assert.deepEqual(calls, []);
  });
});

describe("panel de equipo (Dueño)", () => {
  it("solo el Dueño ve el botón", () => {
    for (const [role, hidden] of [["OWNER", false], ["EDITOR", true], ["VIEWER", true]]) {
      const { elements } = setup({ access: { ...OWNER_ACCESS, me: { ...OWNER_ACCESS.me, role } }, routes: { "GET /v1/workspaces": () => json({ workspaces: [] }) } });
      assert.equal(elements["account-team-toggle"].hidden, hidden, role);
    }
  });

  it("al abrirlo carga miembros e invitaciones una vez, y marca a quien eres", async () => {
    setSessionMode(true);
    const { elements, calls } = setup({ routes: ownerRoutes() });
    elements["account-team-toggle"].fire("click");
    await flush();
    assert.equal(elements["team-panel"].hidden, false);
    assert.equal(elements["account-team-toggle"].getAttribute("aria-expanded"), "true");
    assert.equal(elements["team-members"].children.length, 2);
    assert.equal(elements["team-members"].children[0].children[0].textContent, `Ana (${t("team.you")})`);
    assert.equal(elements["team-invites-empty"].hidden, false);
    elements["account-team-toggle"].fire("click");
    elements["account-team-toggle"].fire("click");
    await flush();
    assert.equal(calls.filter((call) => call.key === "GET /v1/workspaces/members").length, 1, "no recarga al reabrir");
  });

  it("cambiar un rol lo envía; si el API dice que es el último Dueño (409), lo explica y vuelve a mostrar el rol real", async () => {
    setSessionMode(true);
    let deny = false;
    const { elements, calls } = setup({
      routes: ownerRoutes({ [`PUT /v1/workspaces/members/${OTHER_ID}`]: () => (deny ? json({ statusCode: 409, error: "Conflict", code: "last_owner" }, 409) : json({ userId: OTHER_ID, role: "VIEWER" })) }),
    });
    elements["account-team-toggle"].fire("click");
    await flush();
    const betoRole = elements["team-members"].children[1].children[1];
    betoRole.value = "VIEWER";
    betoRole.fire("change");
    await flush();
    assert.deepEqual(calls.find((call) => call.key.startsWith("PUT "))?.body, { role: "VIEWER" });

    deny = true;
    elements["team-members"].children[1].children[1].value = "OWNER";
    elements["team-members"].children[1].children[1].fire("change");
    await flush();
    assert.equal(elements["team-problem"].hidden, false);
    assert.equal(elements["team-problem"].textContent, t("team.error.lastOwner"));
    assert.equal(elements["team-members"].children[1].children[1].value, "EDITOR", "el selector vuelve al rol real");
  });

  it("el tope de invitaciones y el «único espacio» tienen su propio texto: nunca el del último Dueño", async () => {
    setSessionMode(true);
    const { elements } = setup({
      routes: ownerRoutes({
        "POST /v1/workspaces/invites": () => json({ statusCode: 409, code: "invite_limit" }, 409),
        [`DELETE /v1/workspaces/members/${OTHER_ID}`]: () => json({ statusCode: 409, code: "last_membership" }, 409),
      }),
    });
    elements["account-team-toggle"].fire("click");
    await flush();
    elements["team-invite-form"].fire("submit");
    await flush();
    await flush();
    assert.equal(elements["team-problem"].textContent, t("team.error.inviteLimit"));
    const removeButton = () => elements["team-members"].children[1].children[2];
    removeButton().fire("click");
    await flush();
    removeButton().fire("click");
    await flush();
    assert.equal(elements["team-problem"].textContent, t("team.error.lastMembership"));
    assert.notEqual(elements["team-problem"].textContent, t("team.error.lastOwner"));
  });

  it("quitar pide confirmar: la primera pulsación no borra, la segunda sí", async () => {
    setSessionMode(true);
    const { elements, calls } = setup({ routes: ownerRoutes({ [`DELETE /v1/workspaces/members/${OTHER_ID}`]: () => new Response(null, { status: 204 }) }) });
    elements["account-team-toggle"].fire("click");
    await flush();
    const removeButton = () => elements["team-members"].children[1].children[2];
    assert.equal(removeButton().textContent, t("team.remove"));
    removeButton().fire("click");
    await flush();
    assert.equal(calls.some((call) => call.key.startsWith("DELETE")), false);
    assert.equal(removeButton().textContent, t("team.remove.confirm"));
    removeButton().fire("click");
    await flush();
    assert.equal(calls.some((call) => call.key === `DELETE /v1/workspaces/members/${OTHER_ID}`), true);
  });

  it("crear una invitación muestra el enlace una vez y se puede copiar", async () => {
    setSessionMode(true);
    const link = `http://localhost:3000/?invite=cfi_${"a".repeat(43)}`;
    const { elements, calls, clipboard, announced } = setup({
      routes: ownerRoutes({ "POST /v1/workspaces/invites": () => json({ id: OTHER_ID, role: "EDITOR", createdAt: "2026-10-22T00:00:00Z", expiresAt: "2026-10-29T00:00:00Z", link }, 201) }),
    });
    elements["team-invite-role"].value = "EDITOR";
    elements["team-invite-form"].fire("submit");
    await flush();
    await flush();
    assert.deepEqual(calls.find((call) => call.key === "POST /v1/workspaces/invites")?.body, { role: "EDITOR" });
    assert.equal(elements["team-link-box"].hidden, false);
    assert.equal(elements["team-link"].textContent, link);
    assert.deepEqual(announced, [t("team.inviteCreatedAnnounce")]);
    elements["team-copy"].fire("click");
    await flush();
    assert.deepEqual(clipboard, [link]);
    assert.equal(elements["team-copy"].textContent, t("team.copied"));
  });

  it("las invitaciones pendientes se listan con su vencimiento y se pueden revocar", async () => {
    setSessionMode(true);
    const { elements, calls } = setup({
      routes: ownerRoutes({
        "GET /v1/workspaces/invites": () => json({ invites: [{ id: OTHER_ID, role: "VIEWER", createdAt: "2026-10-22T00:00:00Z", expiresAt: "2026-10-29T00:00:00Z" }] }),
        [`DELETE /v1/workspaces/invites/${OTHER_ID}`]: () => new Response(null, { status: 204 }),
      }),
    });
    elements["account-team-toggle"].fire("click");
    await flush();
    assert.equal(elements["team-invites"].children.length, 1);
    assert.match(elements["team-invites"].children[0].children[0].textContent, /^Lector · Vence: /);
    elements["team-invites"].children[0].children[1].fire("click");
    await flush();
    assert.equal(calls.some((call) => call.key === `DELETE /v1/workspaces/invites/${OTHER_ID}`), true);
  });
});
