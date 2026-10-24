// Configuración de IA visible para cualquier miembro del espacio (ADR 0022): host y modelo de OpenAI, nunca la URL ni la clave.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAiConfig } from "../public/js/api/ai-config.js";
import { ApiError } from "../public/js/api/errors.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("getAiConfig", () => {
  it("pide /v1/workspaces/current/ai-config y devuelve host y modelo", async () => {
    let seen = "";
    const result = await getAiConfig({ baseUrl: "http://x/", fetchImpl: async (url) => ((seen = url), json({ openai: { model: "deepseek-chat", baseUrlHost: "api.deepseek.com" } })) });
    assert.equal(seen, "http://x/v1/workspaces/current/ai-config");
    assert.deepEqual(result, { openai: { model: "deepseek-chat", baseUrlHost: "api.deepseek.com" } });
  });

  it("acepta openai: null y campos nulos", async () => {
    assert.deepEqual(await getAiConfig({ baseUrl: "", fetchImpl: async () => json({ openai: null }) }), { openai: null });
    assert.deepEqual(await getAiConfig({ baseUrl: "", fetchImpl: async () => json({ openai: { model: null, baseUrlHost: null } }) }), { openai: { model: null, baseUrlHost: null } });
  });

  it("descarta campos de más: solo se conserva lo conocido", async () => {
    const result = await getAiConfig({ baseUrl: "", fetchImpl: async () => json({ openai: { model: "m", baseUrlHost: "h.example.com", key: "sk-secreto" }, otro: 1 }) });
    assert.deepEqual(result, { openai: { model: "m", baseUrlHost: "h.example.com" } });
  });

  for (const [name, body] of [["sin openai", {}], ["openai de otro tipo", { openai: 5 }], ["modelo que no es texto", { openai: { model: 5, baseUrlHost: null } }], ["host que no es texto", { openai: { model: null, baseUrlHost: {} } }], ["no es un objeto", []]]) {
    it(`una respuesta inesperada (${name}) es bad_response`, async () => {
      await assert.rejects(getAiConfig({ baseUrl: "", fetchImpl: async () => json(body) }), (error) => error instanceof ApiError && error.code === "bad_response");
    });
  }

  it("un error del API (función apagada) sube como ApiError", async () => {
    await assert.rejects(getAiConfig({ baseUrl: "", fetchImpl: async () => json({ statusCode: 404, code: "byok_disabled", message: "x" }, 404) }), (error) => error instanceof ApiError);
  });
});
