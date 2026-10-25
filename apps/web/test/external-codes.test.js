import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES, getCapabilities } from "../public/js/api/capabilities.js";
import { errorFromResponse } from "../public/js/api/errors.js";
import { deleteExternalKey, listExternalKeys, saveExternalKey } from "../public/js/api/external-keys.js";

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const body = (code) => JSON.stringify({ statusCode: 0, code, message: "texto del servidor" });

describe("errorFromResponse: códigos estables de claves externas, traducir y doblar", () => {
  const cases = [
    [400, "invalid_key_format", "invalid_key_format"],
    [400, "same_language", "same_language"],
    [400, "burn_not_available_for_audio", "burn_not_available_for_audio"],
    [400, "mix_not_available_for_audio", "mix_not_available_for_audio"],
    [404, "byok_disabled", "byok_disabled"],
    [409, "byok_disabled", "byok_disabled"],
    [409, "external_key_missing", "external_key_missing"],
    [413, "job_too_large", "job_too_large"],
  ];
  for (const [status, bodyCode, expected] of cases) {
    it(`${status} con code=${bodyCode} -> ${expected}`, () => {
      assert.equal(errorFromResponse(status, body(bodyCode), null).code, expected);
    });
  }

  it("un code desconocido en el cuerpo no cambia el código por estado", () => {
    assert.equal(errorFromResponse(409, body("inventado"), null).code, "conflict");
    assert.equal(errorFromResponse(413, body("inventado"), null).code, "too_large");
  });

  it("un code que es una propiedad del prototipo no rompe nada ni se toma por válido", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(errorFromResponse(409, body(code), null).code, "conflict", code);
      assert.equal(errorFromResponse(400, body(code), null).code, "invalid_request", code);
    }
  });

  it("el código del cuerpo no pisa a un estado que no le corresponde (un 500 sigue siendo del servidor)", () => {
    assert.equal(errorFromResponse(500, body("same_language"), null).code, "server");
  });
});

describe("getCapabilities: claves propias (BYOK)", () => {
  it("lee si están activadas y qué proveedores admite", async () => {
    const fetchImpl = async () => json({ diarization: { enabled: false }, byok: { enabled: true, providers: ["openai", "elevenlabs"] } });
    const found = await getCapabilities({ baseUrl: "", fetchImpl });
    assert.deepEqual(found.byok, { enabled: true, providers: ["openai", "elevenlabs"], allowPrivateBaseUrls: false });
  });

  it("un servidor sin `byok` (o con forma rara) la deja apagada", async () => {
    for (const payload of [{ diarization: { enabled: true } }, { byok: null }, { byok: { enabled: "true", providers: ["openai"] } }, { byok: { enabled: true, providers: "openai" } }]) {
      const found = await getCapabilities({ baseUrl: "", fetchImpl: async () => json(payload) });
      assert.deepEqual(found.byok, { enabled: false, providers: [], allowPrivateBaseUrls: false }, JSON.stringify(payload));
    }
  });

  it("no repite proveedores", async () => {
    const found = await getCapabilities({ baseUrl: "", fetchImpl: async () => json({ byok: { enabled: true, providers: ["openai", "openai", "elevenlabs"] } }) });
    assert.deepEqual(found.byok.providers, ["openai", "elevenlabs"]);
  });

  it("solo conserva proveedores conocidos y de tipo texto", async () => {
    const found = await getCapabilities({ baseUrl: "", fetchImpl: async () => json({ byok: { enabled: true, providers: ["openai", "otro", 7] } }) });
    assert.deepEqual(found.byok.providers, ["openai"]);
  });

  it("sin respuesta, BYOK apagada", () => {
    assert.deepEqual(NO_CAPABILITIES.byok, { enabled: false, providers: [], allowPrivateBaseUrls: false });
  });
});

describe("api/external-keys", () => {
  const record = () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body) });
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : json(init.method === "PUT" ? { provider: "openai", last4: "abcd", createdAt: "2026-10-23T00:00:00Z", rotatedAt: null } : { keys: [{ provider: "openai", last4: "abcd", createdAt: "2026-10-23T00:00:00Z", rotatedAt: null }] });
    };
    return { calls, fetchImpl };
  };

  it("lista las claves del espacio", async () => {
    const { calls, fetchImpl } = record();
    const keys = await listExternalKeys({ baseUrl: "http://api.test/", fetchImpl });
    assert.equal(calls[0].url, "http://api.test/v1/workspaces/current/external-keys");
    assert.deepEqual(keys.map((key) => [key.provider, key.last4]), [["openai", "abcd"]]);
  });

  it("una lista rota no se toma por «sin claves»", async () => {
    await assert.rejects(listExternalKeys({ baseUrl: "", fetchImpl: async () => json({}) }), { code: "bad_response" });
  });

  it("guarda con PUT y solo manda la clave; la respuesta no contiene la clave", async () => {
    const { calls, fetchImpl } = record();
    const view = await saveExternalKey({ baseUrl: "", provider: "openai", key: "sk-secreto-1234", fetchImpl });
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].url, "/v1/workspaces/current/external-keys/openai");
    assert.deepEqual(calls[0].body, { key: "sk-secreto-1234" });
    assert.equal(JSON.stringify(view).includes("sk-secreto"), false);
  });

  it("borra con DELETE", async () => {
    const { calls, fetchImpl } = record();
    await deleteExternalKey({ baseUrl: "", provider: "elevenlabs", fetchImpl });
    assert.deepEqual([calls[0].method, calls[0].url], ["DELETE", "/v1/workspaces/current/external-keys/elevenlabs"]);
  });

  it("rechaza un proveedor que no es de la lista antes de tocar la red", async () => {
    const { calls, fetchImpl } = record();
    await assert.rejects(saveExternalKey({ baseUrl: "", provider: "../x", key: "k", fetchImpl }));
    await assert.rejects(deleteExternalKey({ baseUrl: "", provider: "otro", fetchImpl }));
    assert.equal(calls.length, 0);
  });
});
