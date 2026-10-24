import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifactUrl, startDub, startTranslate } from "../public/js/api/jobs.js";
import { characterCount } from "../public/js/domain/spend.js";
import { parseHistory } from "../public/js/domain/history.js";
import { messages } from "../public/js/i18n/messages.js";

const JOB = "6f1d2c3e-1111-4222-8333-000000000001";
const json = (body, status = 202) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const view = { id: "6f1d2c3e-1111-4222-8333-000000000002", kind: "TRANSLATE", status: "QUEUED", stage: null, percent: 0, message: null };

function recorder(response = () => json(view)) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => (calls.push({ url, method: init.method, body: JSON.parse(init.body) }), response()) };
}

describe("startTranslate / startDub", () => {
  it("traducir manda proveedor e idioma de destino a /translate", async () => {
    const { calls, fetchImpl } = recorder();
    const job = await startTranslate({ baseUrl: "http://api.test/", jobId: JOB, provider: "openai", targetLanguage: "en", fetchImpl });
    assert.deepEqual([calls[0].method, calls[0].url], ["POST", `http://api.test/v1/jobs/${JOB}/translate`]);
    assert.deepEqual(calls[0].body, { provider: "openai", targetLanguage: "en" });
    assert.equal(job.id, view.id);
  });

  it("doblar manda proveedor, voz y mezcla; translationId solo si se eligió", async () => {
    const { calls, fetchImpl } = recorder();
    await startDub({ baseUrl: "", jobId: JOB, provider: "elevenlabs", voice: "Rachel_01", mix: "duck", fetchImpl });
    assert.equal(calls[0].url, `/v1/jobs/${JOB}/dub`);
    assert.deepEqual(calls[0].body, { provider: "elevenlabs", voice: "Rachel_01", mix: "duck" });
    await startDub({ baseUrl: "", jobId: JOB, provider: "openai", voice: "alloy", mix: "none", translationId: view.id, fetchImpl });
    assert.deepEqual(calls[1].body, { provider: "openai", voice: "alloy", mix: "none", translationId: view.id });
  });

  it("un id de trabajo que no es UUID no sale a la red", async () => {
    const { calls, fetchImpl } = recorder();
    await assert.rejects(startTranslate({ baseUrl: "", jobId: "../x", provider: "argos", targetLanguage: "en", fetchImpl }));
    await assert.rejects(startDub({ baseUrl: "", jobId: "no", provider: "openai", voice: "a", mix: "none", fetchImpl }));
    assert.equal(calls.length, 0);
  });

  it("el error del API conserva su código estable", async () => {
    const { fetchImpl } = recorder(() => json({ code: "external_key_missing", message: "x" }, 409));
    await assert.rejects(startDub({ baseUrl: "", jobId: JOB, provider: "openai", voice: "a", mix: "none", fetchImpl }), { code: "external_key_missing" });
  });

  it("el audio del doblaje es un artefacto conocido", () => {
    assert.equal(artifactUrl("", JOB, "audio"), `/v1/jobs/${JOB}/artifacts/audio`);
  });
});

describe("characterCount", () => {
  it("suma el texto de cada subtítulo sin los espacios de los extremos", () => {
    assert.equal(characterCount([{ text: " Hola mundo" }, { text: "Segunda  " }, { text: "   " }]), 10 + 7);
  });

  it("cuenta puntos de código, no unidades UTF-16 (un emoji es uno)", () => {
    assert.equal(characterCount([{ text: "a\u{1F600}b" }]), 3);
  });

  it("sin subtítulos o con basura es cero", () => {
    assert.equal(characterCount([]), 0);
    assert.equal(characterCount([{ text: 5 }, null]), 0);
  });
});

describe("historial con traducciones y doblajes", () => {
  it("acepta los tipos TRANSLATE y DUB", () => {
    const base = { name: "charla.mp4", at: 1000, parentId: JOB };
    const raw = JSON.stringify([{ ...base, id: view.id, kind: "TRANSLATE" }, { ...base, id: "6f1d2c3e-1111-4222-8333-000000000003", kind: "DUB" }]);
    assert.deepEqual(parseHistory(raw).map((entry) => entry.kind), ["TRANSLATE", "DUB"]);
  });
});

describe("textos de traducir y doblar en los 6 idiomas", () => {
  const codes = ["EXTERNAL_KEY_MISSING", "EXTERNAL_AUTH_FAILED", "EXTERNAL_RATE_LIMITED", "EXTERNAL_QUOTA_EXCEEDED", "EXTERNAL_TIMEOUT", "EXTERNAL_UNAVAILABLE", "JOB_TOO_LARGE"];
  it("cada código de fallo del trabajo tiene su texto, distinto del genérico", () => {
    for (const [lang, table] of Object.entries(messages)) {
      for (const code of codes) {
        assert.ok(table[`job.error.${code}`], `${lang} job.error.${code}`);
        assert.notEqual(table[`job.error.${code}`], table["job.error.INTERNAL"], `${lang} ${code} no debe ser el genérico`);
      }
    }
  });

  it("las etapas nuevas y los tipos del historial están traducidos", () => {
    for (const [lang, table] of Object.entries(messages)) {
      for (const key of ["stage.synthesizing", "stage.mixing", "history.kind.TRANSLATE", "history.kind.DUB"]) assert.ok(table[key], `${lang} ${key}`);
    }
  });

  it("la cuota agotada orienta a la persona a su proveedor, no a reintentar", () => {
    assert.match(messages.es["job.error.EXTERNAL_QUOTA_EXCEEDED"], /saldo|cuota|límite/i);
    assert.match(messages.en["job.error.EXTERNAL_QUOTA_EXCEEDED"], /balance|quota|limit/i);
  });
});
