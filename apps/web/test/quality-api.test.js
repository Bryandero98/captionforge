import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { getQuality, getQualityProfiles, proposeQualityFix } from "../public/js/api/jobs.js";

const ID = "6f1d2c3e-1111-4222-8333-444455556666";
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

const summary = { segments: 2, errors: 1, warnings: 0, infos: 0, score: 50 };
const report = { profile: "netflix", etag: "e1", summary, issues: [{ segment: 1, rule: "cps", severity: "warning", measured: 21.5, limit: 20 }] };

describe("getQualityProfiles", () => {
  it("pide /v1/quality/profiles y devuelve la lista", async () => {
    const profiles = [{ id: "netflix", label: "Netflix (inglés)", verification: "verified", reference: "…" }];
    const { fetchImpl, calls } = fakeFetch(json({ profiles }));
    assert.deepEqual(await getQualityProfiles({ baseUrl: "", fetchImpl }), profiles);
    assert.equal(calls[0].url, "/v1/quality/profiles");
  });

  it("una respuesta sin lista es bad_response", async () => {
    const { fetchImpl } = fakeFetch(json({ nope: true }));
    await assert.rejects(getQualityProfiles({ baseUrl: "", fetchImpl }), (error) => error instanceof ApiError && error.code === "bad_response");
  });
});

describe("getQuality", () => {
  it("pide el informe del perfil elegido, codificado en la URL", async () => {
    const { fetchImpl, calls } = fakeFetch(json(report));
    const result = await getQuality({ baseUrl: "http://api.test/", jobId: ID, profile: "netflix-es", fetchImpl });
    assert.equal(calls[0].url, `http://api.test/v1/jobs/${ID}/quality?profile=netflix-es`);
    assert.equal(result.summary.score, 50);
  });

  it("no arma la URL con un id inválido ni deja pasar un perfil raro", async () => {
    const { fetchImpl } = fakeFetch(json(report));
    await assert.rejects(getQuality({ baseUrl: "", jobId: "../x", profile: "netflix", fetchImpl }), TypeError);
    await assert.rejects(getQuality({ baseUrl: "", jobId: ID, profile: "a&b=c", fetchImpl }), TypeError);
  });

  it("una forma inesperada es bad_response", async () => {
    const { fetchImpl } = fakeFetch(json({ profile: "netflix", summary: {}, issues: "no" }));
    await assert.rejects(getQuality({ baseUrl: "", jobId: ID, profile: "netflix", fetchImpl }), (error) => error instanceof ApiError && error.code === "bad_response");
  });

  it("propaga el código de error del API (400 de perfil, 409 si no terminó)", async () => {
    const { fetchImpl } = fakeFetch(new Response(JSON.stringify({ statusCode: 409, message: "x" }), { status: 409, headers: { "content-type": "application/json" } }));
    await assert.rejects(getQuality({ baseUrl: "", jobId: ID, profile: "netflix", fetchImpl }), (error) => error instanceof ApiError && error.status === 409);
  });
});

describe("proposeQualityFix", () => {
  const fix = { profile: "netflix", etag: "e1", edits: [{ index: 0, text: "a\nb" }], changes: [{ segment: 0, kind: "line_break", before: { start: 0, end: 1, text: "a b" }, after: { start: 0, end: 1, text: "a\nb" } }], unfixable: [], before: summary, after: { ...summary, errors: 0, score: 100 } };

  it("hace POST con el perfil y devuelve la propuesta sin guardarla", async () => {
    const { fetchImpl, calls } = fakeFetch(json(fix));
    const result = await proposeQualityFix({ baseUrl: "", jobId: ID, profile: "bbc", fetchImpl });
    assert.equal(calls[0].url, `/v1/jobs/${ID}/quality/fix`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { profile: "bbc" });
    assert.equal(result.etag, "e1");
    assert.equal(result.edits.length, 1);
  });

  it("una propuesta con forma inesperada es bad_response", async () => {
    const { fetchImpl } = fakeFetch(json({ ...fix, edits: "no" }));
    await assert.rejects(proposeQualityFix({ baseUrl: "", jobId: ID, profile: "bbc", fetchImpl }), (error) => error instanceof ApiError && error.code === "bad_response");
  });
});
