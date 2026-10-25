// Modo Rápido (v1.3.0, T7): el resumen vivo, el perfil sugerido y «Control total» se mantienen coherentes sin que la persona toque nada.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES } from "../public/js/api/capabilities.js";
import { PREFS_KEY } from "../public/js/domain/prefs.js";
import { createQuickMode } from "../public/js/ui/quick-mode.js";
import { FakeElement } from "./helpers/fake-dom.js";

const IDS = [
  "advanced", "opt-profile", "opt-model", "opt-source", "opt-translate", "opt-clean", "opt-diarize", "opt-autoburn", "opt-burn-theme",
  "advanced-reset", "quick-summary", "quick-suggestion", "quick-suggestion-text", "quick-suggestion-change",
  "quick-suggestion-dismiss", "quick-warning",
];

const PORTRAIT = { kind: "video", durationSeconds: 48, width: 1080, height: 1920 };
const LANDSCAPE_LONG = { kind: "video", durationSeconds: 1800, width: 1920, height: 1080 };
const AUDIO_LONG = { kind: "audio", durationSeconds: 900, width: null, height: null };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    data,
  };
}

function setup({ storage = memoryStorage(), caps = { ...NO_CAPABILITIES, diarization: { enabled: true } }, facts = {}, pending = () => 0 } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  els.advanced.open = true;
  els["opt-model"].value = "small";
  els["opt-burn-theme"].value = "modern";
  const doc = { getElementById: (id) => els[id] ?? null, createElement: () => new FakeElement() };
  const announced = [];
  const probed = [];
  const quick = createQuickMode({
    doc,
    t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
    storage,
    getCaps: () => caps,
    probe: async (file, kind) => (probed.push(file.name), facts[file.name] ?? { kind, durationSeconds: null, width: null, height: null }),
    announce: (text) => announced.push(text),
    pending,
    languageName: (code) => code.toUpperCase(),
  });
  const item = (name, kind = "video") => ({ key: name, file: { name, size: 10 }, kind });
  return { quick, els, storage, announced, probed, item };
}

const summary = (els) => els["quick-summary"].textContent;

describe("modo rápido: arranque", () => {
  it("cierra «Control total», llena el selector de perfiles y describe el modo estándar", () => {
    const { els } = setup();
    assert.equal(els.advanced.open, false);
    assert.deepEqual(els["opt-profile"].children.map((o) => o.value), ["auto", "vertical", "podcast", "meeting", "quick-clip", "standard"]);
    assert.equal(els["opt-profile"].value, "auto");
    assert.match(summary(els), /quick\.sum\.profile/);
    assert.equal(els["quick-warning"].hidden, true);
    assert.equal(els["quick-suggestion"].hidden, true);
  });

  it("con preferencias guardadas las aplica a los controles y queda en manual", () => {
    const stored = JSON.stringify({ v: 2, modelSize: "medium", sourceLanguage: "es", translateTo: "en", cleanAudio: true, diarize: false, autoBurn: true, burnTheme: "clean-color", burnKaraoke: false, autoProfile: true });
    const { els, quick } = setup({ storage: memoryStorage({ [PREFS_KEY]: stored }) });
    assert.equal(els["opt-model"].value, "medium");
    assert.equal(els["opt-source"].value, "es");
    assert.equal(els["opt-translate"].value, "en");
    assert.equal(els["opt-clean"].checked, true);
    assert.equal(els["opt-autoburn"].checked, true);
    assert.equal(els["opt-burn-theme"].value, "clean-color");
    assert.equal(quick.plan("x").source, "manual");
    assert.match(summary(els), /quick\.sum\.manual/);
  });

  it("sin almacenamiento todo funciona igual", () => {
    const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => { throw new Error("bloqueado"); } };
    const { els } = setup({ storage: broken });
    els["opt-model"].value = "base";
    els["opt-model"].fire("change");
    assert.equal(els["opt-model"].value, "base");
  });
});

describe("modo rápido: perfil sugerido", () => {
  it("un video vertical corto sugiere Vertical, sincroniza los controles y avisa de no cerrar la pestaña", async () => {
    const { quick, els, item, announced } = setup({ facts: { "short.mp4": PORTRAIT } });
    quick.track([item("short.mp4")]);
    await quick.settled();
    assert.match(summary(els), /profile\.vertical/);
    assert.match(summary(els), /quick\.sum\.after\.vertical/);
    assert.equal(els["opt-autoburn"].checked, true);
    assert.equal(els["opt-burn-theme"].value, "shorts-dynamic");
    assert.equal(els["quick-suggestion"].hidden, false);
    assert.match(els["quick-suggestion-text"].textContent, /quick\.suggest/);
    assert.match(els["quick-suggestion-text"].textContent, /intent\.portrait_short/);
    assert.equal(els["quick-warning"].hidden, false);
    assert.deepEqual(quick.plan("short.mp4").followUp, { burn: { canvas: "vertical", template: "bold-pop" } });
    assert.equal(announced.length, 1, "el cambio de resumen se anuncia una vez");
  });

  it("una reunión larga pide hablantes y no encadena nada (sin aviso de pestaña)", async () => {
    const { quick, els, item } = setup({ facts: { "m.mp4": LANDSCAPE_LONG } });
    quick.track([item("m.mp4")]);
    await quick.settled();
    assert.equal(els["opt-diarize"].checked, true);
    assert.match(summary(els), /quick\.sum\.speakers/);
    assert.equal(els["quick-warning"].hidden, true);
    assert.equal(quick.plan("m.mp4").followUp, null);
  });

  it("un audio no encadena el quemado aunque la persona lo marque en Control total", async () => {
    const { quick, els, item } = setup({ facts: { "p.mp3": AUDIO_LONG } });
    quick.track([item("p.mp3", "audio")]);
    await quick.settled();
    els["opt-autoburn"].checked = true;
    els["opt-autoburn"].fire("change");
    assert.equal(quick.plan("p.mp3").followUp, null);
  });

  it("«Descartar» fija Estándar y oculta la sugerencia", async () => {
    const { quick, els, item } = setup({ facts: { "short.mp4": PORTRAIT } });
    quick.track([item("short.mp4")]);
    await quick.settled();
    els["quick-suggestion-dismiss"].click();
    assert.equal(els["quick-suggestion"].hidden, true);
    assert.equal(quick.plan("short.mp4").profileId, "standard");
    assert.equal(els["quick-warning"].hidden, true);
  });

  it("«Cambiar» abre Control total y enfoca el selector de perfil", async () => {
    const { quick, els, item } = setup({ facts: { "short.mp4": PORTRAIT } });
    quick.track([item("short.mp4")]);
    await quick.settled();
    els["quick-suggestion-change"].click();
    assert.equal(els.advanced.open, true);
    assert.equal(els["opt-profile"].focused, true);
  });

  it("elegir un perfil a mano lo aplica a todos los archivos y no se guarda como preferencia", async () => {
    const { quick, els, item, storage } = setup({ facts: { "a.mp4": PORTRAIT, "b.mp4": LANDSCAPE_LONG } });
    quick.track([item("a.mp4"), item("b.mp4")]);
    await quick.settled();
    els["opt-profile"].value = "podcast";
    els["opt-profile"].fire("change");
    assert.equal(quick.plan("a.mp4").profileId, "podcast");
    assert.equal(quick.plan("b.mp4").profileId, "podcast");
    assert.equal(quick.plan("a.mp4").source, "profile");
    assert.equal(storage.data.has(PREFS_KEY), false);
  });

  it("un lote mixto se resume por perfil", async () => {
    const { quick, els, item } = setup({ facts: { "a.mp4": PORTRAIT, "b.mp4": PORTRAIT, "c.mp4": LANDSCAPE_LONG } });
    quick.track([item("a.mp4"), item("b.mp4"), item("c.mp4")]);
    await quick.settled();
    assert.match(summary(els), /quick\.sum\.batch/);
    assert.match(summary(els), /"count":3/);
  });
});

describe("modo rápido: Control total", () => {
  it("cambiar un control pasa a manual, guarda las preferencias y deja de sugerir", async () => {
    const { quick, els, item, storage } = setup({ facts: { "short.mp4": PORTRAIT } });
    quick.track([item("short.mp4")]);
    await quick.settled();
    els["opt-clean"].checked = true;
    els["opt-clean"].fire("change");
    const plan = quick.plan("short.mp4");
    assert.equal(plan.source, "manual");
    assert.equal(plan.options.cleanAudio, true);
    assert.equal(els["quick-suggestion"].hidden, true);
    assert.match(summary(els), /quick\.sum\.clean/);
    const saved = JSON.parse(storage.data.get(PREFS_KEY));
    assert.equal(saved.cleanAudio, true);
    assert.equal(saved.v, 2);
  });

  it("«crear el video al terminar» activa el aviso de pestaña y habilita formato y plantilla", () => {
    const { quick, els } = setup();
    assert.equal(els["opt-burn-theme"].disabled, true);
    els["opt-autoburn"].checked = true;
    els["opt-autoburn"].fire("change");
    assert.equal(els["opt-burn-theme"].disabled, false);
    assert.equal(els["quick-warning"].hidden, false);
    assert.notEqual(quick.plan("x").followUp, null);
  });

  it("«Restablecer» borra las preferencias y vuelve al automático", async () => {
    const { quick, els, item, storage } = setup({ facts: { "short.mp4": PORTRAIT } });
    quick.track([item("short.mp4")]);
    await quick.settled();
    els["opt-model"].value = "medium";
    els["opt-model"].fire("change");
    assert.equal(storage.data.has(PREFS_KEY), true);
    els["advanced-reset"].click();
    assert.equal(storage.data.has(PREFS_KEY), false);
    assert.equal(quick.plan("short.mp4").source, "auto");
    assert.equal(els["opt-model"].value, "small");
  });

  it("la casilla de hablantes se apaga si el servidor no los ofrece, pero la preferencia guardada se conserva", () => {
    const stored = JSON.stringify({ v: 2, diarize: true });
    const { quick, els, storage } = setup({ storage: memoryStorage({ [PREFS_KEY]: stored }), caps: NO_CAPABILITIES });
    els["opt-diarize"].disabled = true;
    els["opt-clean"].checked = true;
    els["opt-clean"].fire("change");
    assert.equal(JSON.parse(storage.data.get(PREFS_KEY)).diarize, true);
    assert.equal(quick.plan("x").options.diarize, false);
  });
});

describe("modo rápido: ciclo de vida", () => {
  it("el aviso de pestaña también se ve mientras queden encadenados pendientes", () => {
    let pending = 0;
    const { quick, els } = setup({ pending: () => pending });
    assert.equal(els["quick-warning"].hidden, true);
    pending = 2;
    quick.refresh();
    assert.equal(els["quick-warning"].hidden, false);
  });

  it("un archivo ya subido deja de contar para el aviso (queda solo lo que falta por subir y lo pendiente)", async () => {
    let pending = 1;
    const { quick, els, item } = setup({ facts: { "short.mp4": PORTRAIT }, pending: () => pending });
    quick.track([item("short.mp4")]);
    await quick.settled();
    assert.equal(els["quick-warning"].hidden, false);
    quick.track([{ ...item("short.mp4"), done: true }]);
    assert.equal(els["quick-warning"].hidden, false, "sigue el encadenado pendiente");
    pending = 0;
    quick.refresh();
    assert.equal(els["quick-warning"].hidden, true);
  });

  it("track solo analiza los archivos nuevos y olvida los que ya no están; reset vacía todo", async () => {
    const { quick, item, probed, els } = setup({ facts: { "a.mp4": PORTRAIT } });
    quick.track([item("a.mp4")]);
    quick.track([item("a.mp4"), item("b.mp4")]);
    await quick.settled();
    assert.deepEqual(probed, ["a.mp4", "b.mp4"]);
    quick.track([item("b.mp4")]);
    assert.equal(quick.plan("a.mp4").profileId, "standard", "un archivo desconocido se trata como Estándar");
    quick.reset();
    await quick.settled();
    assert.equal(els["quick-suggestion"].hidden, true);
  });

  it("si la lectura de un archivo falla, el plan sigue siendo el de siempre", async () => {
    const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
    els["opt-model"].value = "small";
    const quick = createQuickMode({
      doc: { getElementById: (id) => els[id] ?? null, createElement: () => new FakeElement() },
      t: (key) => key,
      storage: memoryStorage(),
      getCaps: () => NO_CAPABILITIES,
      probe: async () => {
        throw new Error("raro");
      },
      announce: () => {},
      pending: () => 0,
    });
    quick.track([{ key: "a", file: { name: "a", size: 1 }, kind: "video" }]);
    await quick.settled();
    await flush();
    assert.equal(quick.plan("a").profileId, "standard");
  });
});
