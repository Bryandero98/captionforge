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

  it("lee el tope del formato vertical y las plantillas que anuncia el servidor", async () => {
    const fetchImpl = async () => json({ limits: { verticalMaxSeconds: 90 }, burn: { templates: ["clean-color", "bold-pop"] } });
    const caps = await getCapabilities({ baseUrl: "", fetchImpl });
    assert.equal(caps.limits.verticalMaxSeconds, 90);
    assert.deepEqual(caps.burn.templates, ["clean-color", "bold-pop"]);
  });

  it("sin esos datos (servidor anterior) o con datos raros usa los valores de siempre: 600 s y las tres plantillas", async () => {
    assert.equal(NO_CAPABILITIES.limits.verticalMaxSeconds, 600);
    assert.deepEqual(NO_CAPABILITIES.burn.templates, ["bold-pop", "rounded-sweep", "clean-color"]);
    const odd = [
      {},
      { limits: null, burn: null },
      { limits: { verticalMaxSeconds: "90" } },
      { limits: { verticalMaxSeconds: 0 } },
      { limits: { verticalMaxSeconds: -5 } },
      { limits: { verticalMaxSeconds: 1.5 } },
      { limits: { verticalMaxSeconds: 10 ** 9 } },
      { burn: { templates: "bold-pop" } },
      { burn: { templates: [] } },
      { burn: { templates: [1, null, "neon"] } },
    ];
    for (const body of odd) {
      const caps = await getCapabilities({ baseUrl: "", fetchImpl: async () => json(body) });
      assert.equal(caps.limits.verticalMaxSeconds, 600, JSON.stringify(body));
      assert.deepEqual(caps.burn.templates, ["bold-pop", "rounded-sweep", "clean-color"], JSON.stringify(body));
    }
  });

  it("de las plantillas anunciadas solo conserva las que la interfaz sabe dibujar, sin duplicados", async () => {
    const fetchImpl = async () => json({ burn: { templates: ["neon", "rounded-sweep", "rounded-sweep", "<img>"] } });
    assert.deepEqual((await getCapabilities({ baseUrl: "", fetchImpl })).burn.templates, ["rounded-sweep"]);
  });

  it("un servidor viejo sin /v1/capabilities no rompe nada", async () => {
    assert.equal((await getCapabilities({ baseUrl: "", fetchImpl: async () => json({ message: "Cannot GET" }, { status: 404 }) })).diarization.enabled, false);
  });
});

describe("asistente", () => {
  const caps = async (body) => getCapabilities({ baseUrl: "", fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }) });

  it("sin dato del servidor está apagado", () => {
    assert.deepEqual(NO_CAPABILITIES.assistant, { enabled: false, allowPrivateBaseUrls: false });
  });

  it("se enciende solo con enabled:true; las URL privadas solo si además están permitidas", async () => {
    assert.deepEqual((await caps({ assistant: { enabled: true, allowPrivateBaseUrls: true } })).assistant, { enabled: true, allowPrivateBaseUrls: true });
    assert.deepEqual((await caps({ assistant: { enabled: true } })).assistant, { enabled: true, allowPrivateBaseUrls: false });
    assert.deepEqual((await caps({ assistant: { enabled: false, allowPrivateBaseUrls: true } })).assistant, { enabled: false, allowPrivateBaseUrls: false });
    assert.deepEqual((await caps({ assistant: { enabled: "true" } })).assistant, { enabled: false, allowPrivateBaseUrls: false });
    assert.deepEqual((await caps({})).assistant, { enabled: false, allowPrivateBaseUrls: false });
  });
});
