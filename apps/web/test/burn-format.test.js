// Formato del quemado (Issue #13, parte 2): «Clásico 16:9» o «Vertical Shorts 9:16» con plantilla, y el aviso de tiempos aproximados.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { startBurn } from "../public/js/api/jobs.js";
import { createBurn, BURN_TEMPLATES } from "../public/js/ui/burn.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const JOB = "6f1d2c3e-1111-4222-8333-000000000020";
const IDS = ["burn-form", "burn-format", "burn-classic", "burn-vertical", "burn-style", "burn-karaoke", "burn-template", "burn-vertical-hint", "burn-hint", "burn-start", "burn-panel", "burn-status", "burn-bar", "burn-bar-fill", "burn-detail", "burn-notice", "burn-video", "burn-download", "burn-cancel", "burn-open-parent", "burn-reconnect"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup({ start = async () => ({ id: "b".repeat(8), status: "QUEUED", percent: 0 }) } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  for (const id of ["burn-panel", "burn-video", "burn-download", "burn-cancel", "burn-open-parent", "burn-reconnect", "burn-notice", "burn-vertical"]) els[id].hidden = true;
  els["burn-format"].value = "classic";
  els["burn-video"].pause = () => {};
  els["burn-video"].load = () => {};
  const doc = { documentElement: { lang: "es" }, activeElement: null, body: new FakeElement(), getElementById: (id) => els[id] ?? null, createElement: () => new FakeElement() };
  const calls = [];
  const burn = createBurn({
    doc, win: {}, baseUrl: "", t, announce: () => {},
    context: () => ({ job: { id: JOB, originalFilename: "x.mp4", mediaKind: "video" }, hasWords: true, dirty: false }),
    onStarted: () => {}, onOpenParent: () => {}, follower: async () => {},
    start: async (options) => { calls.push(options); return start(options); },
  });
  burn.refreshForm();
  return { burn, els, calls };
}

const choose = (els, format) => {
  els["burn-format"].value = format;
  els["burn-format"].fire("change");
};

describe("formato del quemado", () => {
  it("por defecto es «Clásico 16:9»: se ve estilo y karaoke, no la plantilla, y no se manda ni template ni canvas", async () => {
    const { els, calls } = setup();
    assert.equal(els["burn-classic"].hidden, false);
    assert.equal(els["burn-vertical"].hidden, true);
    els["burn-form"].fire("submit");
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].template, undefined);
    assert.equal(calls[0].canvas, undefined);
    assert.equal(calls[0].style, "modern");
  });

  it("«Vertical Shorts 9:16» muestra las plantillas, esconde el estilo clásico y manda template y canvas", async () => {
    const { els, calls } = setup();
    choose(els, "vertical");
    assert.equal(els["burn-classic"].hidden, true);
    assert.equal(els["burn-vertical"].hidden, false);
    els["burn-template"].value = "rounded-sweep";
    els["burn-form"].fire("submit");
    await flush();
    assert.equal(calls[0].canvas, "vertical");
    assert.equal(calls[0].template, "rounded-sweep");
    assert.equal(calls[0].karaoke, undefined, "la plantilla ya resalta palabra por palabra");
  });

  it("volver a «Clásico» deja de mandar la plantilla", async () => {
    const { els, calls } = setup();
    choose(els, "vertical");
    choose(els, "classic");
    els["burn-form"].fire("submit");
    await flush();
    assert.equal(calls[0].canvas, undefined);
    assert.equal(calls[0].template, undefined);
  });

  it("ofrece las tres plantillas del servidor y un valor inválido cae a la primera", async () => {
    assert.deepEqual([...BURN_TEMPLATES], ["bold-pop", "rounded-sweep", "clean-color"]);
    const { els, calls } = setup();
    choose(els, "vertical");
    els["burn-template"].value = "neon";
    els["burn-form"].fire("submit");
    await flush();
    assert.equal(calls[0].template, "bold-pop");
  });

  it("un formato desconocido se trata como clásico", async () => {
    const { els, calls } = setup();
    choose(els, "cuadrado");
    els["burn-form"].fire("submit");
    await flush();
    assert.equal(calls[0].canvas, undefined);
  });

  it("el 413 de un video de más de 10 minutos explica el límite del formato vertical", async () => {
    const { els } = setup({ start: async () => { throw new ApiError({ code: "job_too_large", status: 413 }); } });
    choose(els, "vertical");
    els["burn-form"].fire("submit");
    await flush();
    assert.equal(els["burn-hint"].textContent, t("burn.error.toolong"));
    assert.match(els["burn-hint"].textContent, /10 minutos/);
  });
});

describe("aviso de tiempos aproximados", () => {
  const quiet = () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("sin red"); };
    const logged = console.error;
    console.error = () => {};
    return () => { globalThis.fetch = original; console.error = logged; };
  };
  const done = (result) => ({ id: "c".repeat(8), kind: "BURN", parentJobId: JOB, status: "COMPLETED", percent: 100, result });

  it("se muestra con el número de subtítulos cuando approximateSegments es mayor que cero", async () => {
    const restore = quiet();
    try {
      const { burn, els } = setup();
      burn.adopt(done({ usedKaraoke: true, approximateSegments: 3 }));
      await flush();
      assert.equal(els["burn-notice"].hidden, false);
      assert.equal(els["burn-notice"].textContent, t("burn.approximate", { count: 3 }));
      assert.match(els["burn-notice"].textContent, /3/);
    } finally { restore(); }
  });

  it("no se muestra con cero, sin el dato o con un quemado fallido", async () => {
    const restore = quiet();
    try {
      for (const job of [done({ approximateSegments: 0 }), done({}), done(null), { ...done({ approximateSegments: 2 }), status: "FAILED" }]) {
        const { burn, els } = setup();
        burn.adopt(job);
        await flush();
        assert.equal(els["burn-notice"].hidden, true, JSON.stringify(job.result) + job.status);
      }
    } finally { restore(); }
  });
});

describe("startBurn con plantilla y lienzo", () => {
  it("manda template y canvas en el cuerpo y no inventa campos", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: JOB, kind: "BURN", status: "QUEUED", percent: 0 }), { status: 202, headers: { "content-type": "application/json" } });
    };
    await startBurn({ baseUrl: "", jobId: JOB, template: "bold-pop", canvas: "vertical", fetchImpl });
    assert.deepEqual(JSON.parse(calls[0].init.body), { template: "bold-pop", canvas: "vertical" });
  });
});
