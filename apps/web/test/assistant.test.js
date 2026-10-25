// Asistente (v1.3.1): estado puro (preferencias, conversación, IA elegida) y la llamada al API con un fetch falso.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { sendChat } from "../public/js/api/assistant.js";
import { ASSISTANT_KEY, MAX_TURNS, addTurn, aiPayload, canSend, forgetAi, loadAssistant, restoreAssistant, saveAssistant, dismissAssistant } from "../public/js/domain/assistant.js";

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => void (data[key] = String(value)), removeItem: (key) => void delete data[key], data };
};
const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => { throw new Error("bloqueado"); } };

describe("preferencias", () => {
  it("sin nada guardado: visible y sin IA", () => {
    assert.deepEqual(loadAssistant(memory()), { hidden: false, ai: null });
  });

  it("guarda y recupera la IA y si se quitó el asistente", () => {
    const storage = memory();
    assert.equal(saveAssistant(storage, { hidden: false, ai: { preset: "deepseek", key: "ds-12345678", model: "deepseek-chat", baseUrl: "" } }), true);
    assert.deepEqual(loadAssistant(storage).ai, { preset: "deepseek", key: "ds-12345678", model: "deepseek-chat", baseUrl: "" });
    assert.equal(dismissAssistant(storage), true);
    assert.equal(loadAssistant(storage).hidden, true);
    assert.equal(loadAssistant(storage).ai?.key, "ds-12345678", "quitar el asistente no borra la clave");
    assert.equal(restoreAssistant(storage), true);
    assert.equal(loadAssistant(storage).hidden, false);
  });

  it("olvidar la IA borra la clave pero conserva si estaba oculto", () => {
    const storage = memory();
    saveAssistant(storage, { hidden: true, ai: { preset: "openai", key: "sk-abcdefghijklmnop", model: "", baseUrl: "" } });
    forgetAi(storage);
    assert.deepEqual(loadAssistant(storage), { hidden: true, ai: null });
  });

  it("un valor corrupto o con formas raras se ignora", () => {
    for (const raw of ["no es json", "[]", "null", JSON.stringify({ hidden: "sí", ai: { key: 5 } })]) {
      const state = loadAssistant(memory({ [ASSISTANT_KEY]: raw }));
      assert.equal(state.hidden, false);
      assert.equal(state.ai, null);
    }
  });

  it("con el almacenamiento bloqueado nada lanza", () => {
    assert.deepEqual(loadAssistant(broken), { hidden: false, ai: null });
    assert.equal(saveAssistant(broken, { hidden: false, ai: null }), false);
    assert.equal(loadAssistant(null).hidden, false);
  });
});

describe("la IA que viaja con cada mensaje", () => {
  it("OpenAI: solo la clave (y el modelo si lo eligió)", () => {
    assert.deepEqual(aiPayload({ preset: "openai", key: "sk-abcdefghijklmnop", model: "gpt-4o", baseUrl: "" }), { key: "sk-abcdefghijklmnop", model: "gpt-4o" });
    assert.deepEqual(aiPayload({ preset: "openai", key: "sk-abcdefghijklmnop", model: "", baseUrl: "" }), { key: "sk-abcdefghijklmnop" });
  });
  it("un servicio de la lista lleva su dirección; «otro» la que escribió", () => {
    assert.equal(aiPayload({ preset: "deepseek", key: "ds-12345678", model: "", baseUrl: "" })?.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(aiPayload({ preset: "custom", key: "k-12345678", model: "m", baseUrl: " https://mi.servidor/v1 " })?.baseUrl, "https://mi.servidor/v1");
  });
  it("sin clave no hay IA", () => {
    assert.equal(aiPayload(null), null);
    assert.equal(aiPayload({ preset: "openai", key: "  ", model: "", baseUrl: "" }), null);
  });
});

describe("conversación", () => {
  it("agrega turnos y conserva solo los últimos", () => {
    let turns = [];
    for (let i = 0; i < MAX_TURNS + 5; i += 1) turns = addTurn(turns, i % 2 === 0 ? "user" : "assistant", `m${i}`);
    assert.equal(turns.length, MAX_TURNS);
    assert.equal(turns[turns.length - 1].content, `m${MAX_TURNS + 4}`);
  });
  it("no agrega vacíos ni roles ajenos", () => {
    assert.deepEqual(addTurn([], "user", "   "), []);
    assert.deepEqual(addTurn([], "system", "hola"), []);
  });
  it("solo se puede enviar con texto, con IA configurada y sin otra respuesta en camino", () => {
    const ai = { preset: "openai", key: "sk-abcdefghijklmnop", model: "", baseUrl: "" };
    assert.equal(canSend({ text: "hola", ai, busy: false }), true);
    assert.equal(canSend({ text: "  ", ai, busy: false }), false);
    assert.equal(canSend({ text: "hola", ai: null, busy: false }), false);
    assert.equal(canSend({ text: "hola", ai, busy: true }), false);
    assert.equal(canSend({ text: "x".repeat(4001), ai, busy: false }), false);
  });
});

describe("sendChat", () => {
  const ok = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("manda la conversación, la IA y el trabajo abierto, y devuelve el texto", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body), method: init.method };
      return ok({ reply: "Hola" })();
    };
    const reply = await sendChat({ baseUrl: "http://x", messages: [{ role: "user", content: "hola" }], ai: { key: "ds-12345678" }, jobId: "abc", fetchImpl });
    assert.equal(reply, "Hola");
    assert.equal(seen.url, "http://x/v1/assistant/chat");
    assert.equal(seen.method, "POST");
    assert.deepEqual(seen.body, { messages: [{ role: "user", content: "hola" }], ai: { key: "ds-12345678" }, jobId: "abc" });
  });

  it("sin jobId no lo manda", async () => {
    let body;
    await sendChat({ baseUrl: "http://x", messages: [], ai: { key: "k" }, fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return ok({ reply: "a" })(); } });
    assert.equal("jobId" in body, false);
  });

  it("una respuesta sin texto es bad_response", async () => {
    await assert.rejects(sendChat({ baseUrl: "http://x", messages: [], ai: { key: "k" }, fetchImpl: ok({ reply: 5 }) }), (e) => e instanceof ApiError && e.code === "bad_response");
  });

  it("los códigos del asistente llegan como códigos estables", async () => {
    const fail = (status, code) => async () => new Response(JSON.stringify({ code, message: "x" }), { status, headers: { "content-type": "application/json" } });
    await assert.rejects(sendChat({ baseUrl: "http://x", messages: [], ai: { key: "k" }, fetchImpl: fail(400, "invalid_ai_config") }), (e) => e.code === "invalid_ai_config");
    await assert.rejects(sendChat({ baseUrl: "http://x", messages: [], ai: { key: "k" }, fetchImpl: fail(502, "ai_unavailable") }), (e) => e.code === "ai_unavailable");
  });
});
