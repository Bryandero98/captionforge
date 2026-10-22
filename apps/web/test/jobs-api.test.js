import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifactUrl, cancelJob, getJob, getSegments, putSegments, startBurn } from "../public/js/api/jobs.js";

const ID = "6f1d2c3e-1111-4222-8333-444455556666";
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** fetch falso que anota la petición y responde lo que se le diga. */
function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response() : response;
  };
  return { fetchImpl, calls };
}

describe("artifactUrl", () => {
  it("construye la ruta del artefacto en el mismo origen o bajo una base", () => {
    assert.equal(artifactUrl("", ID, "srt"), `/v1/jobs/${ID}/artifacts/srt`);
    assert.equal(artifactUrl("http://api.test/", ID, "video"), `http://api.test/v1/jobs/${ID}/artifacts/video`);
  });

  it("rechaza ids y nombres raros: no se arma una ruta a partir de datos sin validar", () => {
    assert.throws(() => artifactUrl("", "../x", "srt"));
    assert.throws(() => artifactUrl("", ID, "../../etc"));
  });
});

describe("getJob / getSegments", () => {
  it("getJob pide /v1/jobs/:id y devuelve el JSON", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ id: ID, status: "COMPLETED", percent: 100 }));
    const job = await getJob({ baseUrl: "", jobId: ID, fetchImpl });
    assert.equal(job.status, "COMPLETED");
    assert.equal(calls[0].url, `/v1/jobs/${ID}`);
    assert.equal(calls[0].init.cache, "no-store");
  });

  it("getSegments devuelve segmentos y etag", async () => {
    const { fetchImpl } = fakeFetch(json({ segments: [{ index: 0, start: 0, end: 1, text: "hola", words: null }], etag: "a".repeat(32) }));
    const result = await getSegments({ baseUrl: "", jobId: ID, fetchImpl });
    assert.equal(result.segments[0].text, "hola");
    assert.equal(result.etag.length, 32);
  });

  it("una respuesta sin la forma esperada es bad_response", async () => {
    const { fetchImpl } = fakeFetch(json({ nada: true }));
    await assert.rejects(getSegments({ baseUrl: "", jobId: ID, fetchImpl }), (error) => error.code === "bad_response");
  });

  it("404 → not_found, 409 → conflict, 429 con Retry-After, 503 → busy", async () => {
    for (const [status, code] of [[404, "not_found"], [409, "conflict"], [429, "rate_limited"], [503, "busy"]]) {
      const { fetchImpl } = fakeFetch(() => json({ message: "x" }, { status, headers: { "retry-after": "7", "content-type": "application/json" } }));
      await assert.rejects(getJob({ baseUrl: "", jobId: ID, fetchImpl }), (error) => error.code === code && (status < 429 || error.retryAfter === 7));
    }
  });

  it("un fallo de red es 'network'; un HTML con 200 es bad_response", async () => {
    await assert.rejects(getJob({ baseUrl: "", jobId: ID, fetchImpl: fakeFetch(new TypeError("Failed to fetch")).fetchImpl }), (error) => error.code === "network");
    const html = new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    await assert.rejects(getJob({ baseUrl: "", jobId: ID, fetchImpl: fakeFetch(html).fetchImpl }), (error) => error.code === "bad_response");
  });

  it("abortar con la señal da 'aborted'", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = async (_url, init) => {
      if (init.signal.aborted) throw new DOMException("x", "AbortError");
      return json({});
    };
    await assert.rejects(getJob({ baseUrl: "", jobId: ID, fetchImpl, signal: controller.signal }), (error) => error.code === "aborted");
  });
});

describe("putSegments", () => {
  it("manda las ediciones y el etag en el cuerpo JSON", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ segments: [], etag: "b".repeat(32) }));
    await putSegments({ baseUrl: "", jobId: ID, edits: [{ index: 2, text: "nuevo" }], etag: "a".repeat(32), fetchImpl });
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), { segments: [{ index: 2, text: "nuevo" }], etag: "a".repeat(32) });
  });

  it("409 (los subtítulos cambiaron) llega como 'conflict'", async () => {
    const { fetchImpl } = fakeFetch(() => json({ message: "cambiaron" }, { status: 409 }));
    await assert.rejects(putSegments({ baseUrl: "", jobId: ID, edits: [], etag: "a".repeat(32), fetchImpl }), (error) => error.code === "conflict");
  });
});

describe("startBurn / cancelJob", () => {
  it("startBurn manda estilo y karaoke y devuelve el trabajo de quemado", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ id: ID, kind: "BURN", status: "QUEUED", percent: 0 }, { status: 202 }));
    const job = await startBurn({ baseUrl: "", jobId: ID, style: "tiktok", karaoke: true, fetchImpl });
    assert.equal(job.kind, "BURN");
    assert.equal(calls[0].url, `/v1/jobs/${ID}/burn`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { style: "tiktok", karaoke: true });
  });

  it("cancelJob hace POST /cancel", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ id: ID, status: "CANCELLED", percent: 0 }, { status: 202 }));
    await cancelJob({ baseUrl: "", jobId: ID, fetchImpl });
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].url, `/v1/jobs/${ID}/cancel`);
  });
});

describe("getSegments: validacion de cada subtitulo", () => {
  it("un elemento nulo o con tipos raros es bad_response, no un fallo mas tarde al pintar", async () => {
    for (const bad of [null, { start: 0, end: 1, text: 5 }, { start: "0", end: 1, text: "x" }, { start: 0, end: Number.NaN, text: "x" }]) {
      const { fetchImpl } = fakeFetch(json({ segments: [bad], etag: "a".repeat(32) }));
      await assert.rejects(getSegments({ baseUrl: "", jobId: ID, fetchImpl }), (error) => error.code === "bad_response");
    }
  });
});
