// Interfaz con audio puro (Issue #14): reproductor <audio> del original y quemado de subtítulos oculto.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createBurn } from "../public/js/ui/burn.js";
import { createSourceAudio } from "../public/js/ui/source-audio.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const JOB = "6f1d2c3e-1111-4222-8333-000000000010";
const OTHER = "6f1d2c3e-1111-4222-8333-000000000011";
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function audioElement() {
  const element = new FakeElement("result-audio");
  element.hidden = true;
  element.paused = true;
  element.pause = () => (element.paused = true);
  element.load = () => {};
  element.removeAttribute = (name) => {
    delete element.attributes[name];
    if (name === "src") element.src = undefined;
  };
  return element;
}

function sourceSetup({ size = 2048, fail = null } = {}) {
  const player = audioElement();
  const calls = [];
  const objectUrls = { made: [], revoked: [] };
  const globals = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => (objectUrls.made.push(blob), `blob:audio-${objectUrls.made.length}`);
  URL.revokeObjectURL = (url) => objectUrls.revoked.push(url);
  const doc = { getElementById: (id) => (id === "result-audio" ? player : null) };
  const gate = { release: () => {} };
  const waits = new Map();
  const source = createSourceAudio({
    doc,
    baseUrl: "",
    fetchArtifact: async ({ jobId, name, signal }) => {
      calls.push({ jobId, name, signal });
      if (fail !== null) throw fail;
      if (waits.has(jobId)) await waits.get(jobId);
      return { headers: { get: (header) => (header === "content-length" ? String(size) : null) }, body: { cancel: async () => {} }, blob: async () => new Blob([new Uint8Array(4)], { type: "audio/mpeg" }) };
    },
  });
  const restore = () => Object.assign(URL, globals);
  return { source, player, calls, objectUrls, restore, waits, gate };
}

describe("reproductor del audio original", () => {
  it("un audio terminado se pide como artefacto «source» y se reproduce desde un Blob", async () => {
    const { source, player, calls, objectUrls, restore } = sourceSetup();
    try {
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "podcast.mp3" });
      await flush();
      assert.equal(calls.length, 1);
      assert.deepEqual([calls[0].jobId, calls[0].name], [JOB, "source"]);
      assert.equal(player.hidden, false);
      assert.equal(player.src, "blob:audio-1");
      assert.equal(objectUrls.made.length, 1);
    } finally {
      restore();
    }
  });

  it("es un <audio controls> estándar con nombre accesible", async () => {
    const { source, player, restore } = sourceSetup();
    try {
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "podcast.mp3" });
      await flush();
      assert.ok(player.getAttribute("aria-label"));
      assert.match(player.getAttribute("aria-label"), /podcast\.mp3|audio/i);
    } finally {
      restore();
    }
  });

  it("un video no usa este reproductor: nada se pide y sigue oculto", async () => {
    const { source, player, calls, restore } = sourceSetup();
    try {
      source.show({ id: JOB, mediaKind: "video", originalFilename: "clase.mp4" });
      source.show({ id: OTHER, originalFilename: "viejo.mp4" });
      await flush();
      assert.equal(calls.length, 0);
      assert.equal(player.hidden, true);
    } finally {
      restore();
    }
  });

  it("al ocultar se detiene el audio y se suelta el Blob", async () => {
    const { source, player, objectUrls, restore } = sourceSetup();
    try {
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "podcast.mp3" });
      await flush();
      source.hide();
      assert.equal(player.hidden, true);
      assert.equal(player.paused, true);
      assert.equal(player.getAttribute("src"), undefined);
      assert.deepEqual(objectUrls.revoked, ["blob:audio-1"]);
    } finally {
      restore();
    }
  });

  it("al ocultar con la descarga en curso se cancela y no llega a crear ningún Blob", async () => {
    const { source, player, calls, objectUrls, waits, restore } = sourceSetup();
    try {
      let release = () => {};
      waits.set(JOB, new Promise((resolve) => (release = resolve)));
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "podcast.mp3" });
      await flush();
      source.hide();
      assert.equal(calls[0].signal.aborted, true);
      release();
      await flush();
      assert.equal(objectUrls.made.length, 0);
      assert.equal(player.hidden, true);
    } finally {
      restore();
    }
  });

  it("pasar a otro audio suelta el anterior antes de cargar el nuevo", async () => {
    const { source, objectUrls, calls, restore } = sourceSetup();
    try {
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "uno.mp3" });
      await flush();
      source.show({ id: OTHER, mediaKind: "audio", originalFilename: "dos.mp3" });
      await flush();
      assert.deepEqual(calls.map((call) => call.jobId), [JOB, OTHER]);
      assert.deepEqual(objectUrls.revoked, ["blob:audio-1"]);
    } finally {
      restore();
    }
  });

  it("una respuesta tardía del audio anterior no pisa al actual", async () => {
    const { source, player, objectUrls, waits, restore } = sourceSetup();
    try {
      let release = () => {};
      waits.set(JOB, new Promise((resolve) => (release = resolve)));
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "uno.mp3" });
      source.show({ id: OTHER, mediaKind: "audio", originalFilename: "dos.mp3" });
      await flush();
      release();
      await flush();
      assert.equal(objectUrls.made.length, 1, "solo el audio vigente crea su Blob");
      assert.equal(player.src, "blob:audio-1");
    } finally {
      restore();
    }
  });

  it("si el original ya no existe (caducó) o falla la red, el reproductor no aparece y no hay error en pantalla", async () => {
    for (const fail of [new ApiError({ status: 404, code: "not_found" }), new TypeError("red")]) {
      const { source, player, restore } = sourceSetup({ fail });
      const quiet = console.error;
      console.error = () => {};
      try {
        source.show({ id: JOB, mediaKind: "audio", originalFilename: "podcast.mp3" });
        await flush();
        assert.equal(player.hidden, true);
      } finally {
        console.error = quiet;
        restore();
      }
    }
  });

  it("un original demasiado grande para la memoria de la página no se previsualiza", async () => {
    const { source, player, objectUrls, restore } = sourceSetup({ size: 300 * 1024 * 1024 });
    try {
      source.show({ id: JOB, mediaKind: "audio", originalFilename: "sesion.wav" });
      await flush();
      assert.equal(player.hidden, true);
      assert.equal(objectUrls.made.length, 0);
    } finally {
      restore();
    }
  });
});

const BURN_IDS = ["burn-form", "burn-format", "burn-classic", "burn-vertical", "burn-template", "burn-notice", "burn-style", "burn-karaoke", "burn-hint", "burn-start", "burn-panel", "burn-status", "burn-bar", "burn-bar-fill", "burn-detail", "burn-video", "burn-download", "burn-cancel", "burn-open-parent", "burn-reconnect"];

function burnSetup(context) {
  const elements = Object.fromEntries(BURN_IDS.map((id) => [id, new FakeElement(id)]));
  for (const id of ["burn-panel", "burn-video", "burn-download", "burn-cancel", "burn-open-parent", "burn-reconnect"]) elements[id].hidden = true;
  elements["burn-video"].pause = () => {};
  elements["burn-video"].load = () => {};
  elements["burn-video"].removeAttribute = () => {};
  const doc = { documentElement: { lang: "es" }, activeElement: null, body: new FakeElement(), getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const state = { context };
  const burn = createBurn({ doc, win: {}, baseUrl: "", t, announce: () => {}, context: () => state.context, onStarted: () => {}, onOpenParent: () => {}, follower: async () => {} });
  return { burn, form: elements["burn-form"], state };
}

describe("quemar subtítulos con audio", () => {
  const ctx = (mediaKind) => ({ job: { id: JOB, originalFilename: "x", ...(mediaKind ? { mediaKind } : {}) }, hasWords: true, dirty: false });

  it("con un video el formulario se ve", () => {
    for (const kind of ["video", undefined]) {
      const { burn, form } = burnSetup(ctx(kind));
      burn.refreshForm();
      assert.equal(form.hidden, false, String(kind));
    }
  });

  it("con un audio el formulario de quemado no existe", () => {
    const { burn, form } = burnSetup(ctx("audio"));
    burn.refreshForm();
    assert.equal(form.hidden, true);
  });

  it("al abrir un video después de un audio el formulario vuelve", () => {
    const { burn, form, state } = burnSetup(ctx("audio"));
    burn.refreshForm();
    state.context = ctx("video");
    burn.refreshForm();
    assert.equal(form.hidden, false);
  });
});
