// Tema del quemado (Issue #13 parte 2 y v1.3.0): cada tema de la galería se traduce a las opciones de siempre de POST /burn,
// y el aviso de tiempos aproximados.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES } from "../public/js/api/capabilities.js";
import { ApiError } from "../public/js/api/errors.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { startBurn } from "../public/js/api/jobs.js";
import { createBurn, BURN_TEMPLATES } from "../public/js/ui/burn.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const JOB = "6f1d2c3e-1111-4222-8333-000000000020";
const IDS = ["burn-form", "burn-themes", "burn-preview", "burn-preview-text", "burn-preview-note", "burn-classic", "burn-vertical", "burn-karaoke", "burn-vertical-hint", "burn-hint", "burn-start", "burn-panel", "burn-status", "burn-bar", "burn-bar-fill", "burn-detail", "burn-notice", "burn-video", "burn-download", "burn-cancel", "burn-open-parent", "burn-reconnect"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup({ start = async () => ({ id: "b".repeat(8), status: "QUEUED", percent: 0 }), job = {}, sample = "Hola a todos", caps = NO_CAPABILITIES } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  for (const id of ["burn-panel", "burn-video", "burn-download", "burn-cancel", "burn-open-parent", "burn-reconnect", "burn-notice", "burn-vertical"]) els[id].hidden = true;
  els["burn-video"].pause = () => {};
  els["burn-video"].load = () => {};
  const doc = { documentElement: { lang: "es" }, activeElement: null, body: new FakeElement(), getElementById: (id) => els[id] ?? null, createElement: () => new FakeElement() };
  const calls = [];
  const burn = createBurn({
    doc, win: {}, baseUrl: "", t, announce: () => {},
    context: () => ({ job: { id: JOB, originalFilename: "x.mp4", mediaKind: "video", ...job }, hasWords: true, dirty: false, sample }),
    onStarted: () => {}, onOpenParent: () => {}, follower: async () => {},
    start: async (options) => { calls.push(options); return start(options); },
    getCaps: () => caps,
    reducedMotion: () => true,
  });
  burn.refreshForm();
  return { burn, els, calls };
}

const radios = (els) => els["burn-themes"].children.flatMap((group) => group.children).filter((node) => node.attributes.role === "radio");
const radio = (els, id) => radios(els).find((node) => node.dataset.theme === id);
const pick = (els, id) => radio(els, id).click();
const submit = async (els) => {
  els["burn-form"].fire("submit");
  await flush();
};

describe("tema del quemado", () => {
  it("por defecto es «Moderno» (el estilo de siempre): se ve el karaoke, no el aviso vertical, y no se manda ni template ni canvas", async () => {
    const { els, calls } = setup();
    assert.equal(els["burn-classic"].hidden, false);
    assert.equal(els["burn-vertical"].hidden, true);
    await submit(els);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].template, undefined);
    assert.equal(calls[0].canvas, undefined);
    assert.equal(calls[0].style, "modern");
    assert.equal(calls[0].karaoke, false);
  });

  it("cada tema clásico manda su estilo", async () => {
    for (const [id, style] of [["minimal-pro", "minimal"], ["classic-youtube", "youtube"], ["tiktok-bold", "tiktok"]]) {
      const { els, calls } = setup();
      pick(els, id);
      await submit(els);
      assert.equal(calls[0].style, style, id);
      assert.equal(calls[0].canvas, undefined, id);
    }
  });

  it("un tema vertical muestra el aviso del formato, esconde el karaoke y manda lienzo y plantilla", async () => {
    const { els, calls } = setup();
    pick(els, "soft-rounded");
    assert.equal(els["burn-classic"].hidden, true);
    assert.equal(els["burn-vertical"].hidden, false);
    await submit(els);
    assert.equal(calls[0].canvas, "vertical");
    assert.equal(calls[0].template, "rounded-sweep");
    assert.equal(calls[0].style, undefined);
    assert.equal(calls[0].karaoke, undefined, "la plantilla ya resalta palabra por palabra");
  });

  it("volver a un tema clásico deja de mandar la plantilla", async () => {
    const { els, calls } = setup();
    pick(els, "shorts-dynamic");
    pick(els, "modern");
    await submit(els);
    assert.equal(calls[0].canvas, undefined);
    assert.equal(calls[0].template, undefined);
  });

  it("el karaoke marcado viaja con un tema clásico", async () => {
    const { els, calls } = setup();
    els["burn-karaoke"].checked = true;
    els["burn-karaoke"].fire("change");
    await submit(els);
    assert.equal(calls[0].karaoke, true);
  });

  it("ofrece las tres plantillas del servidor, una por tema vertical", async () => {
    assert.deepEqual([...BURN_TEMPLATES], ["bold-pop", "rounded-sweep", "clean-color"]);
    const sent = [];
    for (const id of ["shorts-dynamic", "soft-rounded", "clean-color"]) {
      const { els, calls } = setup();
      pick(els, id);
      await submit(els);
      sent.push(calls[0].template);
    }
    assert.deepEqual(sent, [...BURN_TEMPLATES]);
  });

  it("un video más largo que el tope vertical desactiva los temas verticales y vuelve al tema por defecto", async () => {
    const { els, calls } = setup({ job: { result: { durationSeconds: 900 } } });
    const vertical = radio(els, "shorts-dynamic");
    assert.equal(vertical.attributes["aria-disabled"], "true");
    vertical.click();
    await submit(els);
    assert.equal(calls[0].canvas, undefined);
    assert.match(radio(els, "shorts-dynamic").children.at(-1).textContent, /10 min/);
  });

  it("una plantilla que el servidor no ofrece desactiva su tema", () => {
    const { els } = setup({ caps: { ...NO_CAPABILITIES, burn: { templates: ["bold-pop"] } } });
    assert.equal(radio(els, "soft-rounded").attributes["aria-disabled"], "true");
    assert.equal(radio(els, "shorts-dynamic").attributes["aria-disabled"], "false");
  });

  it("la vista previa usa las palabras del primer subtítulo", () => {
    const { els } = setup({ sample: "Buenas noches a todos los que ven" });
    assert.deepEqual(els["burn-preview-text"].children.map((w) => w.textContent), ["Buenas", "noches", "a", "todos", "los", "que", "ven"]);
  });

  it("el 413 de un video de más de 10 minutos explica el límite del formato vertical", async () => {
    const { els } = setup({ start: async () => { throw new ApiError({ code: "job_too_large", status: 413 }); } });
    pick(els, "shorts-dynamic");
    await submit(els);
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
