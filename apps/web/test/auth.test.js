import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { STORAGE_KEY, authHeaders, hasApiKey, loadApiKey, setApiKey } from "../public/js/api/auth.js";
import { getJob } from "../public/js/api/jobs.js";
import { streamJobEvents } from "../public/js/api/sse.js";
import { uploadVideo } from "../public/js/api/upload.js";
import { FakeXHR } from "./helpers/fake-xhr.js";

const KEY = `cfk_${"b".repeat(64)}`;
const JOB_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  setApiKey("");
  FakeXHR.reset();
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("clave de API de la interfaz", () => {
  it("sin clave no manda ninguna cabecera", () => {
    assert.deepEqual(authHeaders(), {});
    assert.equal(hasApiKey(), false);
  });

  it("setApiKey acepta una clave razonable y descarta lo raro", () => {
    setApiKey(`  ${KEY}  `);
    assert.deepEqual(authHeaders(), { "X-API-Key": KEY });
    for (const bad of ["", "   ", "con espacio", "salto\nde linea", "x".repeat(300), null, 42]) {
      setApiKey(bad);
      assert.deepEqual(authHeaders(), {}, JSON.stringify(bad));
    }
  });

  describe("loadApiKey", () => {
    it("toma la clave de /web-config.json del mismo origen", async () => {
      const calls = [];
      const fetchImpl = async (url, init) => (calls.push([url, init.cache]), jsonResponse({ apiKey: KEY }));
      assert.equal(await loadApiKey({ baseUrl: "", fetchImpl }), "server");
      assert.deepEqual(calls, [["/web-config.json", "no-store"]]);
      assert.deepEqual(authHeaders(), { "X-API-Key": KEY });
    });

    it("la guardada en el navegador tiene prioridad y no consulta al servidor", async () => {
      const fetchImpl = async () => assert.fail("no debía pedir /web-config.json");
      const storage = { getItem: (name) => (name === STORAGE_KEY ? KEY : null) };
      assert.equal(await loadApiKey({ baseUrl: "", storage, fetchImpl }), "storage");
      assert.equal(hasApiKey(), true);
    });

    it("nunca lanza: sin ruta, con red caída, con JSON roto o con localStorage que falla se queda sin clave", async () => {
      const throwingStorage = { getItem: () => { throw new Error("bloqueado"); } };
      const cases = [
        async () => new Response("no", { status: 404 }),
        async () => { throw new TypeError("sin red"); },
        async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
        async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
        async () => jsonResponse({ apiKey: 42 }),
      ];
      for (const fetchImpl of cases) {
        assert.equal(await loadApiKey({ baseUrl: "", storage: throwingStorage, fetchImpl }), "none");
        assert.equal(hasApiKey(), false);
      }
    });
  });

  describe("se manda en todas las peticiones", () => {
    it("fetch JSON (getJob)", async () => {
      setApiKey(KEY);
      let seen;
      const fetchImpl = async (_url, init) => ((seen = init.headers), jsonResponse({ id: JOB_ID, status: "QUEUED", percent: 0 }));
      await getJob({ baseUrl: "", jobId: JOB_ID, fetchImpl });
      assert.equal(seen["X-API-Key"], KEY);
    });

    it("XMLHttpRequest de la subida", () => {
      setApiKey(KEY);
      const file = new File([new Uint8Array(16)], "a.mp4", { type: "video/mp4" });
      void uploadVideo({ file, options: {}, createXhr: () => new FakeXHR() }).catch(() => {});
      assert.equal(FakeXHR.last.headers["x-api-key"], KEY);
    });

    it("flujo SSE", async () => {
      setApiKey(KEY);
      let seen;
      const fetchImpl = async (_url, init) => ((seen = init.headers), new Response("", { status: 404 }));
      await streamJobEvents({ baseUrl: "", jobId: JOB_ID, fetchImpl, onJob: () => {} }).catch(() => {});
      assert.equal(seen["X-API-Key"], KEY);
    });

    it("sin clave, ninguna de las tres la inventa", async () => {
      let seen;
      const fetchImpl = async (_url, init) => ((seen = init.headers), jsonResponse({ id: JOB_ID, status: "QUEUED", percent: 0 }));
      await getJob({ baseUrl: "", jobId: JOB_ID, fetchImpl });
      assert.equal("X-API-Key" in seen, false);
    });
  });
});
