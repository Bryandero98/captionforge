// Guía interactiva (v1.3.1): estado puro, primera visita y almacenamiento que puede fallar.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOUR_KEY, TOUR_STEPS, closeTour, goNext, goPrevious, hasSeenTour, markTourSeen, openTour, shouldAutoOpen } from "../public/js/domain/tour.js";

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => void (data[key] = String(value)), data };
};
const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); } };

describe("pasos", () => {
  it("hay seis pasos con id único y un elemento de destino", () => {
    assert.equal(TOUR_STEPS.length, 6);
    assert.equal(new Set(TOUR_STEPS.map((step) => step.id)).size, 6);
    for (const step of TOUR_STEPS) assert.match(step.target, /^[a-z][a-z0-9-]*$/);
  });
});

describe("navegación", () => {
  it("abre en el primer paso y avanza o retrocede sin salirse de los límites", () => {
    let state = openTour();
    assert.deepEqual(state, { open: true, index: 0 });
    assert.equal(goPrevious(state).index, 0);
    for (let i = 0; i < 20; i += 1) state = goNext(state);
    assert.equal(state.index, TOUR_STEPS.length - 1);
    assert.equal(goPrevious(state).index, TOUR_STEPS.length - 2);
  });
  it("cerrar la deja cerrada y conserva el paso para poder reanudar no: vuelve a empezar al abrir", () => {
    const closed = closeTour(goNext(openTour()));
    assert.equal(closed.open, false);
    assert.equal(openTour().index, 0);
  });
  it("no avanza ni retrocede si está cerrada", () => {
    const closed = closeTour(openTour());
    assert.deepEqual(goNext(closed), closed);
    assert.deepEqual(goPrevious(closed), closed);
  });
});

describe("primera visita", () => {
  it("se abre sola solo si nunca se vio y el almacenamiento funciona", () => {
    const storage = memory();
    assert.equal(hasSeenTour(storage), false);
    assert.equal(shouldAutoOpen(storage), true);
    markTourSeen(storage);
    assert.equal(storage.data[TOUR_KEY], "1");
    assert.equal(hasSeenTour(storage), true);
    assert.equal(shouldAutoOpen(storage), false);
  });
  it("un valor ajeno o raro cuenta como no visto, pero solo «1» cuenta como visto", () => {
    assert.equal(hasSeenTour(memory({ [TOUR_KEY]: "0" })), false);
    assert.equal(hasSeenTour(memory({ [TOUR_KEY]: "true" })), false);
    assert.equal(hasSeenTour(memory({ [TOUR_KEY]: "1" })), true);
  });
  it("sin almacenamiento no se abre sola (no se insistiría en cada visita) y marcar no lanza", () => {
    assert.equal(shouldAutoOpen(broken), false);
    assert.equal(shouldAutoOpen(null), false);
    assert.doesNotThrow(() => markTourSeen(broken));
    assert.doesNotThrow(() => markTourSeen(null));
  });
});
