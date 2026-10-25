// Cliente de POST /v1/jobs/:id/quality/check (editor guiado, ADR 0027).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { checkQuality } from "../public/js/api/jobs.js";

const ID = "6f1d2c3e-1111-4222-8333-444455556666";
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const summary = { segments: 1, errors: 0, warnings: 1, infos: 0, score: 0 };
const check = {
  profile: "netflix",
  summary,
  issues: [{ segment: 0, rule: "cpl", severity: "warning", measured: 70, limit: 42 }],
  fixes: [{ segment: 0, rules: ["cpl"], kinds: ["line_break"], edit: { text: "a\nb" } }],
};
const segments = [{ start: 0, end: 6, text: "texto" }];

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

describe("checkQuality", () => {
  it("manda perfil y subtítulos (solo start, end y text) por POST y devuelve el informe con arreglos", async () => {
    const { fetchImpl, calls } = fakeFetch(json(check));
    const result = await checkQuality({ baseUrl: "http://api.test/", jobId: ID, profile: "netflix", segments: [{ start: 0, end: 6, text: "texto", words: [1], index: 3 }], fetchImpl });
    assert.equal(calls[0].url, `http://api.test/v1/jobs/${ID}/quality/check`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { profile: "netflix", segments });
    assert.equal(result.fixes[0].edit.text, "a\nb");
  });

  it("una señal ya cancelada llega al fetch y la petición falla", async () => {
    const fetchImpl = async (_url, init) => {
      if (init.signal.aborted) throw new DOMException("cancelado", "AbortError");
      return json(check);
    };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(checkQuality({ baseUrl: "", jobId: ID, profile: "netflix", segments, signal: controller.signal, fetchImpl }));
  });

  it("no arma la petición con un id o un perfil inválidos", async () => {
    const { fetchImpl, calls } = fakeFetch(json(check));
    await assert.rejects(checkQuality({ baseUrl: "", jobId: "../x", profile: "netflix", segments, fetchImpl }), TypeError);
    await assert.rejects(checkQuality({ baseUrl: "", jobId: ID, profile: "a&b", segments, fetchImpl }), TypeError);
    assert.equal(calls.length, 0);
  });

  for (const [name, body] of [
    ["sin fixes", { ...check, fixes: undefined }],
    ["un arreglo sin edición", { ...check, fixes: [{ segment: 0, rules: [], kinds: [] }] }],
    ["una edición con tipos raros", { ...check, fixes: [{ segment: 0, rules: [], kinds: [], edit: { text: 5 } }] }],
    ["resumen roto", { ...check, summary: {} }],
    ["incidencias que no son lista", { ...check, issues: "no" }],
  ]) {
    it(`una forma inesperada es bad_response: ${name}`, async () => {
      const { fetchImpl } = fakeFetch(json(body));
      await assert.rejects(checkQuality({ baseUrl: "", jobId: ID, profile: "netflix", segments, fetchImpl }), (error) => error instanceof ApiError && error.code === "bad_response");
    });
  }

  it("propaga el error del API con su estado", async () => {
    const { fetchImpl } = fakeFetch(new Response(JSON.stringify({ statusCode: 409, message: "x" }), { status: 409, headers: { "content-type": "application/json" } }));
    await assert.rejects(checkQuality({ baseUrl: "", jobId: ID, profile: "netflix", segments, fetchImpl }), (error) => error instanceof ApiError && error.status === 409);
  });
});
