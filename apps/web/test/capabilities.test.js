import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES, getCapabilities } from "../public/js/api/capabilities.js";

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("getCapabilities", () => {
  it("lee si identificar hablantes está disponible", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => (calls.push({ url, init }), json({ diarization: { enabled: true } }));
    assert.deepEqual((await getCapabilities({ baseUrl: "http://api.test/", fetchImpl })).diarization, { enabled: true });
    assert.equal(calls[0].url, "http://api.test/v1/capabilities");
    assert.equal(calls[0].init.cache, "no-store");
  });

  it("cualquier fallo o forma rara deja las funciones opcionales apagadas, sin lanzar", async () => {
    const cases = [
      async () => json({}, { status: 404 }),
      async () => json({ diarization: { enabled: "true" } }),
      async () => json({ diarization: null }),
      async () => json([1, 2]),
      async () => new Response("no es json", { status: 200, headers: { "content-type": "application/json" } }),
      async () => {
        throw new TypeError("red caída");
      },
    ];
    for (const fetchImpl of cases) assert.deepEqual(await getCapabilities({ baseUrl: "", fetchImpl }), NO_CAPABILITIES);
  });

  it("lee si el servidor admite direcciones locales (ALLOW_PRIVATE_BASE_URLS) solo con BYOK activo", async () => {
    const byok = (extra) => async () => json({ byok: { enabled: true, providers: ["openai"], ...extra } });
    assert.equal((await getCapabilities({ baseUrl: "", fetchImpl: byok({ allowPrivateBaseUrls: true }) })).byok.allowPrivateBaseUrls, true);
    for (const extra of [{ allowPrivateBaseUrls: false }, { allowPrivateBaseUrls: "true" }, {}]) {
      assert.equal((await getCapabilities({ baseUrl: "", fetchImpl: byok(extra) })).byok.allowPrivateBaseUrls, false);
    }
    const off = async () => json({ byok: { enabled: false, providers: [], allowPrivateBaseUrls: true } });
    assert.equal((await getCapabilities({ baseUrl: "", fetchImpl: off })).byok.allowPrivateBaseUrls, false);
    assert.equal(NO_CAPABILITIES.byok.allowPrivateBaseUrls, false);
  });

  it("un servidor viejo sin /v1/capabilities no rompe nada", async () => {
    assert.equal((await getCapabilities({ baseUrl: "", fetchImpl: async () => json({ message: "Cannot GET" }, { status: 404 }) })).diarization.enabled, false);
  });
});
