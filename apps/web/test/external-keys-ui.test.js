import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setSessionMode } from "../public/js/api/auth.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createExternalKeys } from "../public/js/ui/external-keys.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "sk-proj-SECRETO-DE-PRUEBA-9876";
const owner = { mode: "session", providers: [], me: { tenant: { id: TEAM_ID, name: "Equipo" }, role: "OWNER", user: { id: "u1", name: "Ana", email: null, provider: "github" } } };
const asRole = (role) => ({ ...owner, me: { ...owner.me, role } });
const local = { mode: "key", providers: [], me: null };
const on = { diarization: { enabled: false }, byok: { enabled: true, providers: ["openai", "elevenlabs"] } };
const off = { diarization: { enabled: false }, byok: { enabled: false, providers: [] } };

afterEach(() => setSessionMode(false));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const view = (provider, last4) => ({ provider, last4, createdAt: "2026-10-23T00:00:00Z", rotatedAt: null });

/** Todos los nodos descendientes. */
function walk(node, out = []) {
  for (const child of node.children ?? []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const find = (root, action, provider) => walk(root).find((node) => node.getAttribute("data-action") === action && node.getAttribute("data-provider") === provider);
/** Todo lo que la persona puede leer en la página, atributos incluidos. */
const everything = (root) => walk(root).flatMap((node) => [node.textContent, node.value, ...Object.values(node.attributes)]).join("\n");

function setup({ access = owner, capabilities = on, stored = [view("openai", "abcd")], routes = {} } = {}) {
  const elements = Object.fromEntries(["account-extkeys-toggle", "extkeys-panel", "extkeys-list", "extkeys-problem"].map((id) => [id, new FakeElement(id)]));
  elements["extkeys-panel"].hidden = true;
  elements["account-extkeys-toggle"].hidden = true;
  const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const calls = [];
  let keys = stored;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const key = `${method} ${url}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (routes[key]) return routes[key](init);
    if (key === "GET /v1/workspaces/current/external-keys") return json({ keys });
    const put = /^PUT \/v1\/workspaces\/current\/external-keys\/(openai|elevenlabs)$/.exec(key);
    if (put) {
      keys = [...keys.filter((item) => item.provider !== put[1]), view(put[1], JSON.parse(init.body).key.slice(-4))];
      return json(view(put[1], "zzzz"));
    }
    const del = /^DELETE \/v1\/workspaces\/current\/external-keys\/(openai|elevenlabs)$/.exec(key);
    if (del) {
      keys = keys.filter((item) => item.provider !== del[1]);
      return new Response(null, { status: 204 });
    }
    throw new TypeError(`ruta no prevista: ${key}`);
  };
  const announced = [];
  const ui = createExternalKeys({ doc, baseUrl: "", access, t, announce: (text) => announced.push(text), fetchImpl, capabilities: async () => capabilities });
  return { elements, ui, calls, announced, toggle: elements["account-extkeys-toggle"], panel: elements["extkeys-panel"], list: elements["extkeys-list"], problem: elements["extkeys-problem"] };
}

async function open(options) {
  setSessionMode(true);
  const ctx = setup(options);
  await flush();
  ctx.toggle.fire("click");
  await flush();
  return ctx;
}

describe("quién ve el panel «Claves externas»", () => {
  it("en modo local (clave de este navegador, sin sesión) queda oculto y no toca la red", async () => {
    const { toggle, panel, calls } = setup({ access: local });
    await flush();
    assert.equal(toggle.hidden, true);
    assert.equal(panel.hidden, true);
    assert.deepEqual(calls, []);
  });

  it("un Editor o un Lector no lo ven y no consultan las claves", async () => {
    setSessionMode(true);
    for (const role of ["EDITOR", "VIEWER"]) {
      const { toggle, calls } = setup({ access: asRole(role) });
      await flush();
      assert.equal(toggle.hidden, true, role);
      assert.deepEqual(calls, [], role);
    }
  });

  it("si el servidor no tiene BYOK activado (sin APP_SECRET) queda oculto aunque sea Dueño", async () => {
    setSessionMode(true);
    const { toggle, calls } = setup({ capabilities: off });
    await flush();
    assert.equal(toggle.hidden, true);
    assert.deepEqual(calls, []);
  });

  it("el Dueño con BYOK activado ve el botón, cerrado y sin pedir nada hasta abrirlo", async () => {
    setSessionMode(true);
    const { toggle, panel, calls } = setup();
    await flush();
    assert.equal(toggle.hidden, false);
    assert.equal(panel.hidden, true);
    assert.deepEqual(calls, []);
  });
});

describe("lista de proveedores", () => {
  it("al abrir pide las claves y muestra una fila por proveedor, solo con …últimos 4", async () => {
    const { panel, list, calls, toggle } = await open();
    assert.equal(panel.hidden, false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.deepEqual(calls.map((call) => call.key), ["GET /v1/workspaces/current/external-keys"]);
    assert.equal(list.children.length, 2);
    const text = everything(list);
    assert.match(text, /…abcd/);
    assert.match(text, /Sin clave/);
  });

  it("cada campo es de tipo password, con autocomplete=off, sin valor y con su etiqueta", async () => {
    const { list } = await open();
    const inputs = walk(list).filter((node) => node.getAttribute("data-field") === "key");
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      assert.equal(input.getAttribute("type"), "password");
      assert.equal(input.getAttribute("autocomplete"), "off");
      assert.equal(input.getAttribute("spellcheck"), "false");
      assert.equal(input.value, "");
      assert.ok(input.getAttribute("id"), "necesita id para su <label>");
    }
    const labels = walk(list).filter((node) => node.getAttribute("for")?.startsWith("extkeys-input-"));
    assert.deepEqual(labels.map((label) => label.getAttribute("for")).sort(), inputs.map((input) => input.getAttribute("id")).sort());
  });

  it("«Guardar» si no hay clave, «Reemplazar» y «Borrar» si ya la hay", async () => {
    const { list } = await open();
    assert.equal(find(list, "save", "openai").textContent, "Reemplazar");
    assert.ok(find(list, "delete", "openai"));
    assert.equal(find(list, "save", "elevenlabs").textContent, "Guardar");
    assert.equal(find(list, "delete", "elevenlabs"), undefined);
  });

  it("solo ofrece los proveedores que el servidor declara", async () => {
    const { list } = await open({ capabilities: { ...on, byok: { enabled: true, providers: ["openai"] } } });
    assert.equal(list.children.length, 1);
  });
});

describe("guardar y reemplazar", () => {
  const typeKey = (list, provider, value) => {
    const input = walk(list).find((node) => node.getAttribute("data-field") === "key" && node.getAttribute("data-provider") === provider);
    input.value = value;
    return input;
  };

  it("envía la clave con PUT, vacía el campo y no deja rastro de ella en la página", async () => {
    const { list, calls, announced, problem } = await open();
    const input = typeKey(list, "elevenlabs", `  ${SECRET}  `);
    find(list, "save", "elevenlabs").fire("click");
    await flush();
    const put = calls.find((call) => call.key.startsWith("PUT"));
    assert.equal(put.key, "PUT /v1/workspaces/current/external-keys/elevenlabs");
    assert.deepEqual(put.body, { key: SECRET }); // se recorta
    assert.equal(input.value, "");
    assert.equal(everything(list).includes(SECRET), false);
    assert.equal(everything(problem).includes(SECRET), false);
    assert.equal(announced.some((text) => text.includes(SECRET)), false);
    assert.equal(announced.length, 1);
    // la lista se volvió a pedir y ahora muestra los últimos 4 de lo guardado
    assert.match(everything(list), /…9876/);
  });

  it("con el campo vacío no manda nada y lo explica", async () => {
    const { list, calls, problem } = await open();
    find(list, "save", "openai").fire("click");
    await flush();
    assert.equal(calls.some((call) => call.key.startsWith("PUT")), false);
    assert.equal(problem.hidden, false);
    assert.match(problem.textContent, /Pega la clave/);
  });

  it("un formato inválido se muestra con texto propio, sin repetir lo escrito, y conserva lo tecleado", async () => {
    const { list, problem } = await open({
      routes: { "PUT /v1/workspaces/current/external-keys/openai": () => json({ statusCode: 400, code: "invalid_key_format", message: `La clave ${SECRET} no sirve` }, 400) },
    });
    const input = typeKey(list, "openai", SECRET);
    find(list, "save", "openai").fire("click");
    await flush();
    assert.match(problem.textContent, /formato/);
    assert.equal(problem.textContent.includes(SECRET), false);
    assert.equal(input.value, SECRET); // para corregirla sin volver a pegarla
  });

  it("un fallo de red usa el texto genérico de error", async () => {
    const { list, problem } = await open({ routes: { "PUT /v1/workspaces/current/external-keys/openai": () => { throw new TypeError("sin red"); } } });
    typeKey(list, "openai", SECRET);
    find(list, "save", "openai").fire("click");
    await flush();
    assert.equal(problem.hidden, false);
    assert.equal(problem.textContent.includes(SECRET), false);
  });
});

describe("borrar", () => {
  it("pide una segunda pulsación antes de borrar y luego vuelve a «Sin clave»", async () => {
    const { list, calls } = await open();
    find(list, "delete", "openai").fire("click");
    await flush();
    assert.equal(calls.some((call) => call.key.startsWith("DELETE")), false);
    assert.match(find(list, "delete", "openai").textContent, /Confirmar|Seguro|seguro/);
    find(list, "delete", "openai").fire("click");
    await flush();
    assert.ok(calls.some((call) => call.key === "DELETE /v1/workspaces/current/external-keys/openai"));
    assert.match(everything(list), /Sin clave/);
    assert.equal(find(list, "delete", "openai"), undefined);
  });

  it("si el servidor rechaza el borrado lo dice y la clave sigue en la lista", async () => {
    const { list, problem } = await open({ routes: { "DELETE /v1/workspaces/current/external-keys/openai": () => json({ code: "role_forbidden" }, 403) } });
    find(list, "delete", "openai").fire("click");
    find(list, "delete", "openai").fire("click");
    await flush();
    assert.equal(problem.hidden, false);
    assert.ok(find(list, "delete", "openai"));
  });
});

describe("accesibilidad y robustez", () => {
  it("al pulsar «Borrar» el foco se queda en ese botón aunque la fila se vuelva a pintar", async () => {
    const { list } = await open();
    find(list, "delete", "openai").fire("click");
    await flush();
    assert.equal(find(list, "delete", "openai").focused, true);
  });

  it("el nombre accesible de cada botón contiene su texto visible y el paso de confirmación se anuncia", async () => {
    const { list, announced } = await open();
    assert.match(find(list, "save", "openai").getAttribute("aria-label"), /Reemplazar/);
    assert.match(find(list, "save", "elevenlabs").getAttribute("aria-label"), /Guardar/);
    find(list, "delete", "openai").fire("click");
    await flush();
    assert.match(find(list, "delete", "openai").getAttribute("aria-label"), /Seguro/);
    assert.ok(announced.some((text) => /Seguro/.test(text)));
  });

  it("la confirmación de borrado no caduca sola: se cancela al salir del botón", async () => {
    const { list } = await open();
    find(list, "delete", "openai").fire("click");
    await flush();
    assert.match(find(list, "delete", "openai").textContent, /Seguro/);
    find(list, "delete", "openai").fire("blur");
    await flush();
    assert.equal(find(list, "delete", "openai").textContent, "Borrar");
  });

  it("el campo se describe con su estado («Guardada: …1234»)", async () => {
    const { list } = await open();
    const input = walk(list).find((node) => node.getAttribute("data-field") === "key" && node.getAttribute("data-provider") === "openai");
    const described = walk(list).find((node) => node.getAttribute("id") === input.getAttribute("aria-describedby"));
    assert.match(described.textContent, /…abcd/);
  });

  it("si la lista se repinta con el guardado en vuelo, la clave no reaparece en ningún campo; y un doble clic envía una sola vez", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const puts = [];
    const { list, ui } = await open({
      routes: { "PUT /v1/workspaces/current/external-keys/elevenlabs": async (init) => (puts.push(init.body), await gate, json(view("elevenlabs", "zzzz"))) },
    });
    const input = walk(list).find((node) => node.getAttribute("data-field") === "key" && node.getAttribute("data-provider") === "elevenlabs");
    input.value = SECRET;
    find(list, "save", "elevenlabs").fire("click");
    find(list, "save", "elevenlabs").fire("click");
    await flush();
    ui.refresh(t); // p. ej. un cambio de idioma mientras se guarda
    release();
    await flush();
    await flush();
    assert.equal(puts.length, 1);
    assert.equal(everything(list).includes(SECRET), false);
  });
});
