import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setSessionMode } from "../public/js/api/auth.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createAccount } from "../public/js/ui/account.js";
import { FakeElement } from "./helpers/fake-dom.js";

const KEY = `cfk_${"d".repeat(64)}`;
const ID_A = "33333333-3333-4333-8333-333333333333";
const ME = { tenant: { id: "t1", name: "Ana" }, role: "OWNER", user: { id: "u1", name: "Ana", email: "ana@example.com", provider: "github" } };
const t = createTranslator("es");

afterEach(() => setSessionMode(false));

const IDS = ["app-content", "login-panel", "login-error", "login-github", "login-google", "login-none", "account-bar", "account-name",
  "account-keys-toggle", "account-signout", "keys-panel", "keys-list", "keys-empty", "keys-form", "keys-name", "keys-problem",
  "keys-created", "keys-created-value", "keys-copy", "account-role", "role-note", "account-notice", "login-invite", "upload-form",
  "workspace-select", "account-team-toggle", "team-panel", "team-members", "team-problem", "team-invite-form", "team-invite-role", "team-link-box", "team-link",
  "team-copy", "team-invites", "team-invites-empty"];

function setup({ access, search = "", routes = {}, extra = {} }) {
  const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  elements["keys-panel"].hidden = true;
  const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const clipboard = [];
  const win = { location: { search, reload: () => (win.reloaded = true) }, navigator: { clipboard: { writeText: async (text) => clipboard.push(text) } }, reloaded: false };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === "/v1/workspaces") return json({ workspaces: [] }); // el selector de espacios se prueba en team-ui.test.js
    calls.push(`${init.method ?? "GET"} ${url}`);
    const handler = routes[`${init.method ?? "GET"} ${url}`];
    if (!handler) throw new TypeError(`ruta no prevista: ${init.method ?? "GET"} ${url}`);
    return handler();
  };
  const announced = [];
  const account = createAccount({ doc, win, baseUrl: "", access, t, announce: (text) => announced.push(text), fetchImpl, ...extra });
  return { elements, account, win, calls, clipboard, announced };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const keyView = (over = {}) => ({ id: ID_A, name: "mi script", prefix: "cfk_abcd", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null, revokedAt: null, ...over });

describe("ui/account.js", () => {
  it("modo key: muestra la app, sin barra de cuenta ni pantalla de entrada", () => {
    const { elements } = setup({ access: { mode: "key", providers: [], me: null } });
    assert.equal(elements["app-content"].hidden, false);
    assert.equal(elements["login-panel"].hidden, true);
    assert.equal(elements["account-bar"].hidden, true);
  });

  it("modo login: oculta la app y muestra solo los proveedores configurados con su enlace", () => {
    const { elements } = setup({ access: { mode: "login", providers: ["github"], me: null } });
    assert.equal(elements["app-content"].hidden, true);
    assert.equal(elements["login-panel"].hidden, false);
    assert.equal(elements["login-github"].hidden, false);
    assert.equal(elements["login-github"].getAttribute("href"), "/auth/github/start");
    assert.equal(elements["login-google"].hidden, true);
    assert.equal(elements["login-error"].hidden, true);
  });

  it("modo none: avisa de que el servidor no tiene método de entrada", () => {
    const { elements } = setup({ access: { mode: "none", providers: [], me: null } });
    assert.equal(elements["login-none"].hidden, false);
  });

  it("?login_error= conocido muestra el texto; uno desconocido se ignora", () => {
    const known = setup({ access: { mode: "login", providers: ["github"], me: null }, search: "?login_error=denied" });
    assert.equal(known.elements["login-error"].hidden, false);
    assert.equal(known.elements["login-error"].textContent, t("login.error.denied"));
    const unknown = setup({ access: { mode: "login", providers: ["github"], me: null }, search: "?login_error=<script>" });
    assert.equal(unknown.elements["login-error"].hidden, true);
  });

  it("modo session: muestra la app y la barra con el nombre", () => {
    const { elements } = setup({ access: { mode: "session", providers: ["github"], me: ME } });
    assert.equal(elements["app-content"].hidden, false);
    assert.equal(elements["account-bar"].hidden, false);
    assert.equal(elements["account-name"].textContent, t("account.signedIn", { name: "Ana" }));
  });

  it("abrir el panel carga las claves una vez y marca aria-expanded", async () => {
    setSessionMode(true);
    const { elements, calls } = setup({ access: { mode: "session", providers: [], me: ME }, routes: { "GET /v1/keys": () => json({ keys: [keyView(), keyView({ id: "44444444-4444-4444-8444-444444444444", name: "vieja", revokedAt: "2026-10-02T00:00:00Z" })] }) } });
    elements["account-keys-toggle"].fire("click");
    await flush();
    assert.equal(elements["keys-panel"].hidden, false);
    assert.equal(elements["account-keys-toggle"].getAttribute("aria-expanded"), "true");
    assert.equal(elements["keys-list"].children.length, 2);
    elements["account-keys-toggle"].fire("click");
    elements["account-keys-toggle"].fire("click");
    await flush();
    assert.deepEqual(calls, ["GET /v1/keys"], "no recarga al reabrir");
  });

  it("crear una clave la muestra una vez y vacía el campo", async () => {
    setSessionMode(true);
    const created = { ...keyView(), key: KEY };
    const { elements, announced } = setup({ access: { mode: "session", providers: [], me: ME }, routes: { "POST /v1/keys": () => json(created, 201), "GET /v1/keys": () => json({ keys: [keyView()] }) } });
    elements["keys-name"].value = "  mi script  ";
    elements["keys-form"].fire("submit");
    await flush();
    await flush();
    assert.equal(elements["keys-created"].hidden, false);
    assert.equal(elements["keys-created-value"].textContent, KEY);
    assert.equal(elements["keys-name"].value, "");
    assert.deepEqual(announced, [t("keys.createdAnnounce")]);
  });

  it("un nombre vacío no llama al servidor", async () => {
    const { elements, calls } = setup({ access: { mode: "session", providers: [], me: ME } });
    elements["keys-name"].value = "   ";
    elements["keys-form"].fire("submit");
    await flush();
    assert.deepEqual(calls, []);
  });

  it("el tope de claves (409) se explica con el texto propio, no con uno genérico", async () => {
    setSessionMode(true);
    const { elements } = setup({ access: { mode: "session", providers: [], me: ME }, routes: { "POST /v1/keys": () => json({ statusCode: 409, error: "Conflict" }, 409) } });
    elements["keys-name"].value = "otra";
    elements["keys-form"].fire("submit");
    await flush();
    assert.equal(elements["keys-problem"].hidden, false);
    assert.equal(elements["keys-problem"].textContent, t("keys.error.limit"));
  });

  it("copiar usa el portapapeles y lo dice", async () => {
    setSessionMode(true);
    const { elements, clipboard } = setup({ access: { mode: "session", providers: [], me: ME }, routes: { "POST /v1/keys": () => json({ ...keyView(), key: KEY }, 201), "GET /v1/keys": () => json({ keys: [] }) } });
    elements["keys-name"].value = "x";
    elements["keys-form"].fire("submit");
    await flush();
    await flush();
    elements["keys-copy"].fire("click");
    await flush();
    assert.deepEqual(clipboard, [KEY]);
    assert.equal(elements["keys-copy"].textContent, t("keys.copied"));
  });

  it("salir cierra la sesión y recarga la página, aunque el servidor falle", async () => {
    setSessionMode(true);
    const { elements, win, calls } = setup({ access: { mode: "session", providers: [], me: ME }, routes: { "POST /auth/logout": () => json({ statusCode: 500 }, 500) } });
    elements["account-signout"].fire("click");
    await flush();
    await flush();
    assert.deepEqual(calls, ["POST /auth/logout"]);
    assert.equal(win.reloaded, true);
  });

  it("refresh repinta con el nuevo idioma", () => {
    const { elements, account } = setup({ access: { mode: "session", providers: [], me: ME } });
    account.refresh(createTranslator("en"));
    assert.equal(elements["account-name"].textContent, "Signed in as Ana");
  });

  it("solo el Dueño ve «Equipo» y «Claves de API»; Editor y Lector no", () => {
    for (const [role, visible] of [["OWNER", true], ["EDITOR", false], ["VIEWER", false]]) {
      const { elements } = setup({ access: { mode: "session", providers: [], me: { ...ME, role } } });
      assert.equal(elements["account-keys-toggle"].hidden, !visible, `claves ${role}`);
      assert.equal(elements["account-team-toggle"].hidden, !visible, `equipo ${role}`);
      assert.equal(elements["account-role"].textContent, t(`role.${role}`));
    }
  });

  it("un Lector ve su aviso y no tiene formulario de subida; un Editor sí", () => {
    const viewer = setup({ access: { mode: "session", providers: [], me: { ...ME, role: "VIEWER" } } });
    assert.equal(viewer.elements["role-note"].hidden, false);
    assert.equal(viewer.elements["role-note"].textContent, t("role.note.VIEWER"));
    assert.equal(viewer.elements["upload-form"].hidden, true);
    const editor = setup({ access: { mode: "session", providers: [], me: { ...ME, role: "EDITOR" } } });
    assert.equal(editor.elements["role-note"].hidden, true);
    assert.equal(editor.elements["upload-form"].hidden, false);
  });

  it("el resultado de una invitación se avisa, y una pendiente se explica en la pantalla de entrada", () => {
    const joined = setup({ access: { mode: "session", providers: [], me: ME }, extra: { notice: { kind: "joined", name: "Equipo Sur", role: "EDITOR" } } });
    assert.equal(joined.elements["account-notice"].hidden, false);
    assert.equal(joined.elements["account-notice"].textContent, t("invite.accepted", { name: "Equipo Sur", role: t("role.EDITOR") }));
    const failed = setup({ access: { mode: "session", providers: [], me: ME }, extra: { notice: { kind: "invite_failed" } } });
    assert.equal(failed.elements["account-notice"].textContent, t("invite.failed"));
    const waiting = setup({ access: { mode: "login", providers: ["github"], me: null }, extra: { pendingInvite: true } });
    assert.equal(waiting.elements["login-invite"].hidden, false);
    const normal = setup({ access: { mode: "login", providers: ["github"], me: null } });
    assert.equal(normal.elements["login-invite"].hidden, true);
  });
});
