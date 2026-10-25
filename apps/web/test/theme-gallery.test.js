// Galería de temas (v1.3.0): radiogroup accesible con vista previa aproximada en CSS. Con DOM falso.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEMES } from "../public/js/domain/themes.js";
import { createThemeGallery } from "../public/js/ui/theme-gallery.js";
import { FakeElement } from "./helpers/fake-dom.js";

const key = (k) => ({ key: k });

function setup({ reduced = false, initial } = {}) {
  const els = Object.fromEntries(["burn-themes", "burn-preview", "burn-preview-text", "burn-preview-note"].map((id) => [id, new FakeElement(id)]));
  const doc = { getElementById: (id) => els[id] ?? null, createElement: () => new FakeElement() };
  const changes = [];
  const timers = [];
  const cleared = [];
  const gallery = createThemeGallery({
    doc,
    t: (name, params) => (name === "theme.sample" ? "Así se ven tus subtítulos" : params ? `${name}${JSON.stringify(params)}` : name),
    onChange: (id) => changes.push(id),
    reducedMotion: () => reduced,
    setInterval: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearInterval: (id) => cleared.push(id),
    initial,
  });
  const radios = () => els["burn-themes"].children.flatMap((group) => group.children).filter((node) => node.attributes.role === "radio");
  const checked = () => radios().filter((r) => r.attributes["aria-checked"] === "true").map((r) => r.dataset.theme);
  const words = () => els["burn-preview-text"].children.map((w) => w.textContent);
  const states = () => els["burn-preview-text"].children.map((w) => w.dataset.state);
  return { gallery, els, changes, timers, cleared, radios, checked, words, states };
}

describe("galería de temas: estructura", () => {
  it("es un radiogroup con los siete temas en dos grupos y «Moderno» elegido", () => {
    const { els, radios, checked, gallery } = setup();
    assert.equal(els["burn-themes"].attributes.role, "radiogroup");
    assert.equal(radios().length, THEMES.length);
    assert.deepEqual(checked(), ["modern"]);
    assert.equal(gallery.value, "modern");
    assert.equal(els["burn-themes"].children.length, 2, "dos grupos: formato original y vertical");
    assert.ok(radios().every((r) => r.attributes["aria-describedby"]));
  });

  it("una sola parada de tabulador: el elegido tiene tabindex 0 y los demás -1", () => {
    const { radios } = setup();
    const zero = radios().filter((r) => r.attributes.tabindex === "0");
    assert.equal(zero.length, 1);
    assert.equal(zero[0].dataset.theme, "modern");
    assert.ok(radios().filter((r) => r !== zero[0]).every((r) => r.attributes.tabindex === "-1"));
  });

  it("rotula la vista previa como aproximada y la describe para quien no la ve", () => {
    const { els } = setup();
    assert.equal(els["burn-preview-note"].textContent, "theme.preview.note");
    assert.equal(els["burn-preview"].attributes["aria-hidden"], "true");
  });

  it("puede empezar con otro tema (el de las preferencias); uno desconocido cae al por defecto", () => {
    assert.equal(setup({ initial: "soft-rounded" }).gallery.value, "soft-rounded");
    assert.equal(setup({ initial: "neon" }).gallery.value, "modern");
  });
});

describe("galería de temas: elegir", () => {
  it("un clic elige, avisa una vez y actualiza la vista previa (variables CSS y proporción del marco)", () => {
    const { radios, changes, checked, els } = setup();
    radios().find((r) => r.dataset.theme === "shorts-dynamic").click();
    assert.deepEqual(changes, ["shorts-dynamic"]);
    assert.deepEqual(checked(), ["shorts-dynamic"]);
    assert.equal(els["burn-preview"].style["--cf-lit"], "#FFE500");
    assert.equal(els["burn-preview"].dataset.frame, "vertical");
    radios().find((r) => r.dataset.theme === "minimal-pro").click();
    assert.equal(els["burn-preview"].dataset.frame, "source");
  });

  it("volver a pulsar el ya elegido no avisa", () => {
    const { radios, changes } = setup();
    radios().find((r) => r.dataset.theme === "modern").click();
    assert.deepEqual(changes, []);
  });

  it("select() cambia el tema sin avisar (es un cambio de programa, no un gesto)", () => {
    const { gallery, changes, checked } = setup();
    gallery.select("clean-color");
    assert.deepEqual(changes, []);
    assert.deepEqual(checked(), ["clean-color"]);
    gallery.select("neon");
    assert.equal(gallery.value, "modern");
  });
});

describe("galería de temas: teclado", () => {
  const order = THEMES.map((t) => t.id);

  it("flecha derecha o abajo elige y enfoca el siguiente, y da la vuelta al final", () => {
    const { radios, changes } = setup({ initial: order.at(-1) });
    const last = radios().find((r) => r.dataset.theme === order.at(-1));
    last.fire("keydown", key("ArrowRight"));
    assert.equal(changes.at(-1), order[0]);
    const first = radios().find((r) => r.dataset.theme === order[0]);
    assert.equal(first.focused, true);
    first.fire("keydown", key("ArrowDown"));
    assert.equal(changes.at(-1), order[1]);
  });

  it("flecha izquierda o arriba va al anterior, también dando la vuelta", () => {
    const { radios, changes } = setup({ initial: order[0] });
    radios().find((r) => r.dataset.theme === order[0]).fire("keydown", key("ArrowLeft"));
    assert.equal(changes.at(-1), order.at(-1));
  });

  it("Inicio y Fin saltan al primero y al último", () => {
    const { radios, changes } = setup({ initial: order[2] });
    radios().find((r) => r.dataset.theme === order[2]).fire("keydown", key("End"));
    assert.equal(changes.at(-1), order.at(-1));
    radios().find((r) => r.dataset.theme === order.at(-1)).fire("keydown", key("Home"));
    assert.equal(changes.at(-1), order[0]);
  });

  it("Espacio y Intro eligen el enfocado sin desplazarse; otras teclas no hacen nada", () => {
    const { radios, changes } = setup();
    const target = radios().find((r) => r.dataset.theme === "tiktok-bold");
    target.fire("keydown", key(" "));
    assert.deepEqual(changes, ["tiktok-bold"]);
    target.fire("keydown", key("a"));
    target.fire("keydown", key("Tab"));
    assert.deepEqual(changes, ["tiktok-bold"]);
  });

  it("las flechas llevan el gesto: no desplazan la página", () => {
    const { radios } = setup();
    let prevented = false;
    radios()[0].fire("keydown", { key: "ArrowRight", preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
  });
});

describe("galería de temas: disponibilidad", () => {
  const tooLong = (theme) => (theme.group === "vertical" ? { code: "vertical_too_long", maxMinutes: 10 } : null);

  it("un tema no disponible queda desactivado, dice por qué y no se puede elegir", () => {
    const { gallery, radios, changes } = setup();
    gallery.setAvailability(tooLong);
    const vertical = radios().find((r) => r.dataset.theme === "shorts-dynamic");
    assert.equal(vertical.attributes["aria-disabled"], "true");
    vertical.click();
    vertical.fire("keydown", key(" "));
    assert.deepEqual(changes, []);
    assert.equal(gallery.value, "modern");
  });

  it("las flechas saltan los temas desactivados", () => {
    const { gallery, radios, changes } = setup({ initial: "tiktok-bold" });
    gallery.setAvailability(tooLong);
    radios().find((r) => r.dataset.theme === "tiktok-bold").fire("keydown", key("ArrowRight"));
    assert.equal(changes.at(-1), "minimal-pro", "tras el último clásico da la vuelta sin pasar por los verticales");
  });

  it("si el elegido deja de estar disponible, pasa al tema por defecto y lo avisa", () => {
    const { gallery, changes, checked } = setup({ initial: "soft-rounded" });
    gallery.setAvailability(tooLong);
    assert.deepEqual(checked(), ["modern"]);
    assert.deepEqual(changes, ["modern"]);
  });

  it("al volver a estar disponible se puede elegir otra vez", () => {
    const { gallery, radios, changes } = setup();
    gallery.setAvailability(tooLong);
    gallery.setAvailability(() => null);
    radios().find((r) => r.dataset.theme === "clean-color").click();
    assert.deepEqual(changes, ["clean-color"]);
  });
});

describe("galería de temas: la vista previa con tu texto", () => {
  it("pinta las primeras palabras que caben en ese tema", () => {
    const { gallery, words } = setup({ initial: "shorts-dynamic" });
    gallery.setSample("Hola a todos los que me ven hoy");
    assert.deepEqual(words(), ["Hola", "a", "todos"]);
    gallery.select("soft-rounded");
    assert.deepEqual(words(), ["Hola", "a", "todos", "los"]);
  });

  it("sin texto usa el de muestra del idioma", () => {
    const { words } = setup();
    assert.ok(words().length > 0);
  });

  it("un tema con movimiento arranca un ciclo y cada paso enciende la palabra siguiente", () => {
    const { gallery, timers, states } = setup({ initial: "shorts-dynamic" });
    gallery.setSample("uno dos tres");
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms >= 300 && timers[0].ms <= 700);
    assert.deepEqual(states(), ["active", "idle", "idle"]);
    timers[0].fn();
    assert.deepEqual(states(), ["idle", "active", "idle"]);
  });

  it("un tema estático no arranca ciclo; cambiar de uno a otro para el anterior", () => {
    const { gallery, timers, cleared } = setup({ initial: "modern" });
    assert.equal(timers.length, 0);
    gallery.select("clean-color");
    assert.equal(timers.length, 1);
    gallery.select("minimal-pro");
    assert.deepEqual(cleared, [1]);
  });

  it("con movimiento reducido no hay ciclo y queda una foto fija", () => {
    const { gallery, timers, states } = setup({ reduced: true, initial: "shorts-dynamic" });
    gallery.setSample("uno dos tres");
    assert.equal(timers.length, 0);
    assert.deepEqual(states(), ["active", "idle", "idle"]);
  });

  it("el karaoke convierte un clásico en barrido (y arranca el ciclo); en un vertical no cambia nada", () => {
    const { gallery, timers, els } = setup({ initial: "tiktok-bold" });
    assert.equal(timers.length, 0);
    gallery.setKaraoke(true);
    assert.equal(timers.length, 1);
    assert.equal(els["burn-preview"].style["--cf-base"], "#FFD700");
    gallery.select("shorts-dynamic");
    const before = timers.length;
    gallery.setKaraoke(false);
    assert.equal(timers.length, before, "un vertical ya se mueve por sí solo");
  });

  it("el texto de la persona entra como texto, nunca como marcado", () => {
    const { gallery, els } = setup();
    gallery.setSample('<img src=x onerror="alert(1)"> hola');
    for (const word of els["burn-preview-text"].children) assert.equal(word.innerHTML, undefined);
    assert.ok(!els["burn-preview-text"].children.some((w) => w.textContent.includes("<img")));
  });

  it("stop() detiene el ciclo", () => {
    const { gallery, cleared } = setup({ initial: "shorts-dynamic" });
    gallery.stop();
    assert.deepEqual(cleared, [1]);
  });
});

describe("galería de temas: idioma", () => {
  it("refresh() con otro traductor reescribe nombres y descripciones y conserva la elección", () => {
    const { gallery, radios, checked } = setup({ initial: "clean-color" });
    gallery.refresh((name) => `X:${name}`);
    assert.deepEqual(checked(), ["clean-color"]);
    assert.ok(radios().every((r) => r.attributes["aria-label"]?.startsWith("X:") || r.children.some((c) => String(c.textContent).startsWith("X:"))));
  });
});
