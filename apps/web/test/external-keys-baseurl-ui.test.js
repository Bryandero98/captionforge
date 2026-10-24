// Panel «Claves externas», fila de OpenAI: URL base y modelo opcionales (ADR 0022) para DeepSeek, Groq, OpenRouter o un modelo local.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setSessionMode } from "../public/js/api/auth.js";
import { saveExternalKey } from "../public/js/api/external-keys.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createExternalKeys } from "../public/js/ui/external-keys.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const SECRET = "sk-proj-SECRETO-DE-PRUEBA-9876";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const owner = { mode: "session", providers: [], me: { tenant: { id: TEAM_ID, name: "Equipo" }, role: "OWNER", user: { id: "u1", name: "Ana", email: null, provider: "github" } } };
const on = { diarization: { enabled: false }, byok: { enabled: true, providers: ["openai", "elevenlabs"], allowPrivateBaseUrls: false } };

afterEach(() => setSessionMode(false));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const view = (provider, last4, extra = {}) => ({ provider, last4, createdAt: "2026-10-24T00:00:00Z", rotatedAt: null, baseUrlHost: null, model: null, ...extra });

function walk(node, out = []) {
  for (const child of node.children ?? []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const field = (root, name, provider) => walk(root).find((node) => node.getAttribute("data-field") === name && node.getAttribute("data-provider") === provider);
const button = (root, action, provider) => walk(root).find((node) => node.getAttribute("data-action") === action && node.getAttribute("data-provider") === provider);
const everything = (root) => walk(root).flatMap((node) => [node.textContent, node.value, ...Object.values(node.attributes)]).join("\n");

async function open({ stored = [view("openai", "abcd")], routes = {}, lang = "es", allowPrivate = false } = {}) {
  setSessionMode(true);
  const elements = Object.fromEntries(["account-extkeys-toggle", "extkeys-panel", "extkeys-list", "extkeys-problem"].map((id) => [id, new FakeElement(id)]));
  elements["extkeys-panel"].hidden = true;
  elements["account-extkeys-toggle"].hidden = true;
  const doc = { documentElement: { lang }, getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const calls = [];
  let keys = stored;
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ key, body });
    if (routes[key]) return routes[key](init, body);
    if (key === "GET /v1/workspaces/current/external-keys") return json({ keys });
    const put = /^PUT \/v1\/workspaces\/current\/external-keys\/(openai|elevenlabs)$/.exec(key);
    if (put) {
      const saved = view(put[1], body.key.slice(-4), { baseUrlHost: body.baseUrl ? new URL(body.baseUrl).host : null, model: body.model ?? null });
      keys = [...keys.filter((item) => item.provider !== put[1]), saved];
      return json(saved);
    }
    throw new TypeError(`ruta no prevista: ${key}`);
  };
  const announced = [];
  const translate = createTranslator(lang);
  const ui = createExternalKeys({ doc, baseUrl: "", access: owner, t: translate, announce: (text) => announced.push(text), fetchImpl, capabilities: async () => ({ ...on, byok: { ...on.byok, allowPrivateBaseUrls: allowPrivate } }) });
  await flush();
  elements["account-extkeys-toggle"].fire("click");
  await flush();
  return { elements, ui, calls, announced, list: elements["extkeys-list"], problem: elements["extkeys-problem"] };
}

describe("campos opcionales de la fila de OpenAI", () => {
  it("OpenAI tiene «URL base (API compatible)» y «Modelo»; ElevenLabs no", async () => {
    const { list } = await open();
    assert.ok(field(list, "baseUrl", "openai"));
    assert.ok(field(list, "model", "openai"));
    assert.equal(field(list, "baseUrl", "elevenlabs"), undefined);
    assert.equal(field(list, "model", "elevenlabs"), undefined);
    const labels = walk(list).filter((node) => node.getAttribute("for")).map((node) => node.textContent);
    assert.ok(labels.some((text) => /URL base \(API compatible\)/.test(text)), labels.join("|"));
    assert.ok(labels.some((text) => /^Modelo/.test(text)));
  });

  it("cada campo tiene etiqueta enlazada, es opcional, no autocompleta y ofrece un ejemplo", async () => {
    const { list } = await open();
    for (const name of ["baseUrl", "model"]) {
      const input = field(list, name, "openai");
      assert.ok(input.getAttribute("id"));
      assert.equal(input.getAttribute("autocomplete"), "off");
      assert.equal(input.getAttribute("spellcheck"), "false");
      assert.equal(input.getAttribute("autocapitalize"), "off");
      assert.notEqual(input.getAttribute("type"), "password"); // no son secretos
      assert.ok(input.getAttribute("placeholder"));
      assert.notEqual(input.getAttribute("required"), "true");
      assert.ok(walk(list).some((node) => node.getAttribute("for") === input.getAttribute("id")));
    }
    assert.equal(field(list, "baseUrl", "openai").getAttribute("inputmode"), "url");
  });

  it("el texto de ayuda aclara para qué sirve (DeepSeek, Groq, modelos locales) y los campos lo referencian", async () => {
    const { list } = await open();
    const help = walk(list).find((node) => node.getAttribute("id") === "extkeys-help-openai");
    assert.ok(help, "falta el texto de ayuda");
    assert.match(help.textContent, /DeepSeek/);
    assert.match(help.textContent, /Groq/);
    assert.match(help.textContent, /local/i);
    for (const name of ["baseUrl", "model"]) {
      assert.match(field(list, name, "openai").getAttribute("aria-describedby"), /extkeys-help-openai/);
    }
    assert.equal(walk(list).some((node) => node.getAttribute("id") === "extkeys-help-elevenlabs"), false);
  });
});

describe("guardar con URL base y modelo", () => {
  it("envía key, baseUrl y model; limpia clave y URL, y conserva el modelo guardado", async () => {
    const { list, calls } = await open({ stored: [] });
    const key = field(list, "key", "openai");
    key.value = SECRET;
    field(list, "baseUrl", "openai").value = "  https://api.deepseek.com/v1  ";
    field(list, "model", "openai").value = " deepseek-chat ";
    button(list, "save", "openai").fire("click");
    await flush();
    const put = calls.find((call) => call.key.startsWith("PUT"));
    assert.deepEqual(put.body, { key: SECRET, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });
    assert.equal(field(list, "key", "openai").value, "");
    assert.equal(field(list, "baseUrl", "openai").value, "https://api.deepseek.com/v1"); // la URL de un servicio conocido se deduce de su servidor guardado
    assert.equal(field(list, "model", "openai").value, "deepseek-chat"); // no es secreto: se ve lo guardado
    assert.equal(everything(list).includes(SECRET), false);
  });

  it("los campos vacíos no se envían: solo la clave", async () => {
    const { list, calls } = await open();
    field(list, "key", "openai").value = SECRET;
    button(list, "save", "openai").fire("click");
    await flush();
    assert.deepEqual(calls.find((call) => call.key.startsWith("PUT")).body, { key: SECRET });
  });

  it("ElevenLabs envía solo la clave", async () => {
    const { list, calls } = await open();
    field(list, "key", "elevenlabs").value = SECRET;
    button(list, "save", "elevenlabs").fire("click");
    await flush();
    assert.deepEqual(calls.find((call) => call.key.startsWith("PUT")).body, { key: SECRET });
  });

  it("muestra el servidor y el modelo guardados en el estado de la fila, sin la URL completa", async () => {
    const { list } = await open({ stored: [view("openai", "abcd", { baseUrlHost: "api.deepseek.com", model: "deepseek-chat" })] });
    const state = walk(list).find((node) => node.getAttribute("id") === "extkeys-state-openai").textContent;
    assert.match(state, /abcd/);
    assert.match(state, /api\.deepseek\.com/);
    assert.match(state, /deepseek-chat/);
    assert.equal(state.includes("https://"), false);
  });

  it("al reemplazar la clave de un servidor desconocido, el modelo viene relleno y la URL se pide de nuevo (el API no la devuelve)", async () => {
    const { list } = await open({ stored: [view("openai", "abcd", { baseUrlHost: "llm.mi-empresa.com", model: "mi-modelo" })] });
    assert.equal(field(list, "model", "openai").value, "mi-modelo");
    assert.equal(field(list, "baseUrl", "openai").value, "");
    assert.equal(field(list, "preset", "openai").value, "custom");
    const help = walk(list).find((node) => node.getAttribute("id") === "extkeys-help-openai").textContent;
    assert.match(help, /llm\.mi-empresa\.com/);
    assert.match(help, /vuelve a escribir/i);
  });

  it("una URL base inválida muestra el texto propio, sin repetirla, y conserva lo escrito", async () => {
    const bad = "http://127.0.0.1:11434/v1";
    const { list, problem } = await open({
      routes: { "PUT /v1/workspaces/current/external-keys/openai": () => json({ statusCode: 400, code: "invalid_base_url", message: `La URL ${bad} no vale` }, 400) },
    });
    field(list, "key", "openai").value = SECRET;
    field(list, "baseUrl", "openai").value = bad;
    button(list, "save", "openai").fire("click");
    await flush();
    assert.equal(problem.hidden, false);
    assert.match(problem.textContent, /URL base/);
    assert.equal(problem.textContent.includes(bad), false);
    assert.equal(field(list, "baseUrl", "openai").value, bad);
    assert.equal(field(list, "key", "openai").value, SECRET);
  });

  it("un modelo inválido muestra su texto propio", async () => {
    const { list, problem } = await open({
      routes: { "PUT /v1/workspaces/current/external-keys/openai": () => json({ statusCode: 400, code: "invalid_model", message: "no" }, 400) },
    });
    field(list, "key", "openai").value = SECRET;
    field(list, "model", "openai").value = "mal modelo";
    button(list, "save", "openai").fire("click");
    await flush();
    assert.match(problem.textContent, /modelo/i);
  });
});

describe("api/external-keys.js", () => {
  const capture = () => {
    const sent = [];
    const fetchImpl = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), json(view("openai", "abcd")));
    return { sent, fetchImpl };
  };

  it("incluye baseUrl y model solo cuando tienen contenido", async () => {
    const { sent, fetchImpl } = capture();
    await saveExternalKey({ baseUrl: "", provider: "openai", key: SECRET, fetchImpl });
    await saveExternalKey({ baseUrl: "", provider: "openai", key: SECRET, endpoint: "  ", model: "", fetchImpl });
    assert.deepEqual(sent.map((call) => call.body), [{ key: SECRET }, { key: SECRET }]);
  });

  it("manda baseUrl y model con los nombres que espera el API", async () => {
    const { sent, fetchImpl } = capture();
    await saveExternalKey({ baseUrl: "", provider: "openai", key: SECRET, endpoint: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", fetchImpl });
    assert.deepEqual(sent[0].body, { key: SECRET, baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" });
  });
});

const choose = (list, id) => {
  const select = field(list, "preset", "openai");
  select.value = id;
  select.fire("change");
};
const optionIds = (select) => select.children.map((node) => node.getAttribute("value"));
const suggested = (list) => {
  const model = field(list, "model", "openai");
  const datalist = walk(list).find((node) => node.getAttribute("id") === model.getAttribute("list"));
  return datalist ? datalist.children.map((node) => node.getAttribute("value")) : null;
};

describe("menú de servicios (DeepSeek, Gemini, Claude, Groq, OpenRouter...)", () => {
  it("OpenAI tiene un selector etiquetado con los servicios; ElevenLabs no", async () => {
    const { list } = await open();
    const select = field(list, "preset", "openai");
    assert.ok(select);
    assert.equal(field(list, "preset", "elevenlabs"), undefined);
    assert.ok(walk(list).some((node) => node.getAttribute("for") === select.getAttribute("id")), "falta la etiqueta enlazada");
    assert.deepEqual(optionIds(select), ["openai", "deepseek", "gemini", "anthropic", "groq", "openrouter", "abacus", "custom"]);
    const names = select.children.map((node) => node.textContent);
    for (const brand of ["DeepSeek", "Gemini", "Claude", "Groq", "OpenRouter"]) assert.ok(names.some((name) => name.includes(brand)), brand);
    assert.match(select.getAttribute("aria-describedby"), /extkeys-help-openai/);
  });

  it("Ollama (local) solo aparece si el servidor admite direcciones locales", async () => {
    assert.equal(optionIds(field((await open()).list, "preset", "openai")).includes("ollama"), false);
    const { list } = await open({ allowPrivate: true });
    const ids = optionIds(field(list, "preset", "openai"));
    assert.ok(ids.includes("ollama"));
    assert.equal(ids.at(-1), "custom");
  });

  it("sin nada guardado empieza en OpenAI, sin URL ni modelo", async () => {
    const { list } = await open({ stored: [] });
    assert.equal(field(list, "preset", "openai").value, "openai");
    assert.equal(field(list, "baseUrl", "openai").value, "");
    assert.equal(field(list, "model", "openai").value, "");
  });

  it("elegir DeepSeek rellena la URL base, propone el primer modelo y lista los demás como sugerencias", async () => {
    const { list } = await open({ stored: [] });
    choose(list, "deepseek");
    assert.equal(field(list, "baseUrl", "openai").value, "https://api.deepseek.com/v1");
    assert.equal(field(list, "model", "openai").value, "deepseek-chat");
    assert.deepEqual(suggested(list), ["deepseek-chat", "deepseek-reasoner"]);
  });

  it("cambiar de servicio actualiza URL, modelo sugerido y lista; un modelo escrito a mano se respeta", async () => {
    const { list } = await open({ stored: [] });
    choose(list, "groq");
    assert.equal(field(list, "baseUrl", "openai").value, "https://api.groq.com/openai/v1");
    choose(list, "gemini");
    assert.equal(field(list, "baseUrl", "openai").value, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.match(field(list, "model", "openai").value, /^gemini-/); // el de Groq era una sugerencia: se cambia
    assert.ok(suggested(list).every((name) => name.startsWith("gemini-")));
    field(list, "model", "openai").value = "mi-modelo-afinado";
    field(list, "model", "openai").fire("input");
    choose(list, "anthropic");
    assert.equal(field(list, "baseUrl", "openai").value, "https://api.anthropic.com/v1");
    assert.equal(field(list, "model", "openai").value, "mi-modelo-afinado");
  });

  it("volver a OpenAI vacía la URL; «otro» deja la URL y el modelo como estaban", async () => {
    const { list } = await open({ stored: [] });
    choose(list, "deepseek");
    choose(list, "custom");
    assert.equal(field(list, "baseUrl", "openai").value, "https://api.deepseek.com/v1");
    assert.equal(field(list, "model", "openai").value, "deepseek-chat");
    assert.deepEqual(suggested(list), []);
    choose(list, "openai");
    assert.equal(field(list, "baseUrl", "openai").value, "");
  });

  it("escribir a mano la URL de un servicio conocido selecciona ese servicio; una desconocida, «otro»", async () => {
    const { list } = await open({ stored: [] });
    const url = field(list, "baseUrl", "openai");
    url.value = "https://api.groq.com/openai/v1";
    url.fire("input");
    assert.equal(field(list, "preset", "openai").value, "groq");
    assert.ok(suggested(list).some((name) => name.startsWith("llama")));
    url.value = "https://otro.example.com/v1";
    url.fire("input");
    assert.equal(field(list, "preset", "openai").value, "custom");
    url.value = "";
    url.fire("input");
    assert.equal(field(list, "preset", "openai").value, "openai");
  });

  it("guardar con un servicio elegido envía la clave, la URL y el modelo del menú", async () => {
    const { list, calls } = await open({ stored: [] });
    choose(list, "openrouter");
    field(list, "key", "openai").value = SECRET;
    button(list, "save", "openai").fire("click");
    await flush();
    const body = calls.find((call) => call.key.startsWith("PUT")).body;
    assert.deepEqual(body, { key: SECRET, baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" });
  });

  it("una clave con servidor conocido guardado vuelve con ese servicio, su URL y su modelo para reemplazarla sin retocar nada", async () => {
    const { list } = await open({ stored: [view("openai", "abcd", { baseUrlHost: "api.deepseek.com", model: "deepseek-reasoner" })] });
    assert.equal(field(list, "preset", "openai").value, "deepseek");
    assert.equal(field(list, "baseUrl", "openai").value, "https://api.deepseek.com/v1");
    assert.equal(field(list, "model", "openai").value, "deepseek-reasoner");
  });

  it("lo elegido sobrevive a repintar la lista (cambio de idioma) y el menú sigue traducido", async () => {
    const { list, ui, elements } = await open({ stored: [], lang: "es" });
    choose(list, "gemini");
    ui.refresh(createTranslator("en"));
    const again = elements["extkeys-list"];
    assert.equal(field(again, "preset", "openai").value, "gemini");
    assert.equal(field(again, "baseUrl", "openai").value, "https://generativelanguage.googleapis.com/v1beta/openai");
    const custom = field(again, "preset", "openai").children.find((node) => node.getAttribute("value") === "custom");
    assert.match(custom.textContent, /other|custom/i);
  });

  it("el menú no mete la clave en ningún texto", async () => {
    const { list } = await open({ stored: [] });
    field(list, "key", "openai").value = SECRET;
    choose(list, "groq");
    assert.equal(everything(list).replace(SECRET, "").includes(SECRET), false);
  });
});
