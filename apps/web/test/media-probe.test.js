// Lectura local de metadatos (v1.3.0, iniciativa 1): duración y dimensiones sin subir ni decodificar el archivo, con tiempo máximo y
// degradación a «desconocido». La URL del objeto se revoca SIEMPRE y exactamente una vez.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROBE_TIMEOUT_MS, probeMedia } from "../public/js/domain/media-probe.js";

class FakeMedia {
  constructor(tag) {
    this.tag = tag;
    this.listeners = {};
    this.attributes = {};
    this.preload = "";
    this.muted = false;
    this.duration = Number.NaN;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.loaded = 0;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((other) => other !== fn);
  }
  fire(type) {
    for (const fn of [...(this.listeners[type] ?? [])]) fn({ type });
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "src") this.src = undefined;
  }
  load() {
    this.loaded++;
  }
}

/** Entorno falso: elementos, URL de objetos y un reloj que el test dispara a mano. */
function setup({ createUrlThrows = false, createElementThrows = false } = {}) {
  const env = {
    elements: [],
    created: [],
    revoked: [],
    timers: [],
    cleared: [],
    createElement(tag) {
      if (createElementThrows) throw new Error("sin DOM");
      const element = new FakeMedia(tag);
      env.elements.push(element);
      return element;
    },
    createObjectURL(file) {
      if (createUrlThrows) throw new Error("sin URL");
      const url = `blob:fake/${env.created.length}`;
      env.created.push({ url, file });
      return url;
    },
    revokeObjectURL(url) {
      env.revoked.push(url);
    },
    setTimeout(fn, ms) {
      env.timers.push({ fn, ms });
      return env.timers.length;
    },
    clearTimeout(id) {
      env.cleared.push(id);
    },
  };
  return env;
}

const FILE = { name: "a.mp4", size: 1234 };
const NOTHING = { durationSeconds: null, width: null, height: null };

describe("probeMedia: video", () => {
  it("lee duración y dimensiones con preload=metadata y revoca la URL", async () => {
    const env = setup();
    const promise = probeMedia(FILE, "video", env);
    const element = env.elements[0];
    assert.equal(element.tag, "video");
    assert.equal(element.preload, "metadata");
    assert.equal(element.muted, true);
    assert.equal(element.src, "blob:fake/0");
    Object.assign(element, { duration: 48.4, videoWidth: 1080, videoHeight: 1920 });
    element.fire("loadedmetadata");
    assert.deepEqual(await promise, { kind: "video", durationSeconds: 48.4, width: 1080, height: 1920 });
    assert.deepEqual(env.revoked, ["blob:fake/0"]);
    assert.equal(element.src, undefined, "se suelta el recurso");
  });

  it("dimensiones cero cuentan como desconocidas", async () => {
    const env = setup();
    const promise = probeMedia(FILE, "video", env);
    Object.assign(env.elements[0], { duration: 10, videoWidth: 0, videoHeight: 0 });
    env.elements[0].fire("loadedmetadata");
    assert.deepEqual(await promise, { kind: "video", durationSeconds: 10, width: null, height: null });
  });
});

describe("probeMedia: audio", () => {
  it("usa un elemento de audio y nunca devuelve dimensiones", async () => {
    const env = setup();
    const promise = probeMedia({ name: "a.mp3", size: 10 }, "audio", env);
    const element = env.elements[0];
    assert.equal(element.tag, "audio");
    Object.assign(element, { duration: 1800, videoWidth: 640, videoHeight: 480 });
    element.fire("loadedmetadata");
    assert.deepEqual(await promise, { kind: "audio", durationSeconds: 1800, width: null, height: null });
  });
});

describe("probeMedia: degradación", () => {
  it("un error del medio (formato que el navegador no lee) da «desconocido» y revoca la URL", async () => {
    const env = setup();
    const promise = probeMedia(FILE, "video", env);
    env.elements[0].fire("error");
    assert.deepEqual(await promise, { kind: "video", ...NOTHING });
    assert.deepEqual(env.revoked, ["blob:fake/0"]);
  });

  it("si no llegan metadatos a tiempo (4 s) da «desconocido» y un evento tardío no cambia nada ni revoca dos veces", async () => {
    const env = setup();
    const promise = probeMedia(FILE, "video", env);
    assert.equal(env.timers[0].ms, PROBE_TIMEOUT_MS);
    assert.equal(PROBE_TIMEOUT_MS, 4000);
    env.timers[0].fn();
    assert.deepEqual(await promise, { kind: "video", ...NOTHING });
    Object.assign(env.elements[0], { duration: 5 });
    env.elements[0].fire("loadedmetadata");
    env.elements[0].fire("error");
    assert.deepEqual(env.revoked, ["blob:fake/0"]);
  });

  it("al terminar bien cancela el temporizador", async () => {
    const env = setup();
    const promise = probeMedia(FILE, "video", env);
    Object.assign(env.elements[0], { duration: 3 });
    env.elements[0].fire("loadedmetadata");
    await promise;
    assert.deepEqual(env.cleared, [1]);
  });

  it("una duración infinita o no numérica (emisión en directo, metadatos rotos) es desconocida", async () => {
    for (const duration of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0]) {
      const env = setup();
      const promise = probeMedia(FILE, "video", env);
      Object.assign(env.elements[0], { duration, videoWidth: 640, videoHeight: 360 });
      env.elements[0].fire("loadedmetadata");
      const result = await promise;
      assert.equal(result.durationSeconds, null, String(duration));
      assert.equal(result.width, 640, "las dimensiones válidas se conservan");
    }
  });

  it("si no se puede crear la URL o el elemento, devuelve «desconocido» sin lanzar ni revocar nada", async () => {
    const noUrl = setup({ createUrlThrows: true });
    assert.deepEqual(await probeMedia(FILE, "video", noUrl), { kind: "video", ...NOTHING });
    assert.deepEqual(noUrl.revoked, []);
    const noElement = setup({ createElementThrows: true });
    assert.deepEqual(await probeMedia(FILE, "audio", noElement), { kind: "audio", ...NOTHING });
    assert.deepEqual(noElement.revoked, [], "con el elemento fallido la URL ni siquiera se crea");
    assert.deepEqual(noElement.created, []);
  });

  it("sin entorno (null) devuelve «desconocido»: la subida nunca depende de esto", async () => {
    assert.deepEqual(await probeMedia(FILE, "video", null), { kind: "video", ...NOTHING });
  });

  it("un tipo distinto de audio cuenta como video", async () => {
    const env = setup();
    const promise = probeMedia(FILE, "otra-cosa", env);
    assert.equal(env.elements[0].tag, "video");
    env.elements[0].fire("error");
    assert.equal((await promise).kind, "video");
  });
});
