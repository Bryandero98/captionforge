// Deshacer arreglos del editor guiado (ADR 0027): pila acotada de cambios, sin tocar lo escrito en otros subtítulos.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyFixes, canUndo, currentSegments, dirtyCount, discard, editsOf, openEditor, saved, setText, undo } from "../public/js/domain/editor-state.js";

const ETAG = "a".repeat(32);
const seg = (index, start, end, text) => ({ index, start, end, text, words: null });
const SEGMENTS = [seg(0, 0, 2, " Hola"), seg(1, 2, 4, " Mundo"), seg(2, 4, 6, " Fin")];
const open = () => openEditor(SEGMENTS, ETAG);

describe("vista efectiva", () => {
  it("currentSegments mezcla lo guardado con los borradores, solo start, end y text", () => {
    const state = setText(open(), 1, "Mundo\ncruel");
    assert.deepEqual(currentSegments(state), [
      { start: 0, end: 2, text: " Hola" },
      { start: 2, end: 4, text: "Mundo\ncruel" },
      { start: 4, end: 6, text: " Fin" },
    ]);
  });
});

describe("aplicar un arreglo", () => {
  it("escribe la edición como borrador, sin guardar, y se puede deshacer", () => {
    const fixed = applyFixes(open(), [{ index: 0, edit: { text: "Ho\nla", end: 2.5 } }]);
    assert.deepEqual(editsOf(fixed), [{ index: 0, text: "Ho\nla", end: 2.5 }]);
    assert.equal(canUndo(fixed), true);
    const back = undo(fixed);
    assert.equal(dirtyCount(back), 0);
    assert.equal(canUndo(back), false);
  });

  it("deshacer devuelve el borrador previo del mismo campo, no el original", () => {
    const typed = setText(open(), 0, "Hola amigos");
    const fixed = applyFixes(typed, [{ index: 0, edit: { text: "Hola\namigos" } }]);
    assert.deepEqual(editsOf(undo(fixed)), [{ index: 0, text: "Hola amigos" }]);
  });

  it("deshacer no pisa lo escrito en otros subtítulos después del arreglo", () => {
    const fixed = applyFixes(open(), [{ index: 0, edit: { end: 3 } }]);
    const typed = setText(fixed, 2, "Final");
    assert.deepEqual(editsOf(undo(typed)), [{ index: 2, text: "Final" }]);
  });

  it("«arreglar todos» es un solo paso de deshacer", () => {
    const fixed = applyFixes(open(), [
      { index: 0, edit: { end: 1.5 } },
      { index: 1, edit: { text: "Mun\ndo" } },
    ]);
    assert.equal(dirtyCount(fixed), 2);
    assert.equal(dirtyCount(undo(fixed)), 0);
  });

  it("varios arreglos se deshacen en orden inverso", () => {
    const one = applyFixes(open(), [{ index: 0, edit: { end: 1.5 } }]);
    const two = applyFixes(one, [{ index: 1, edit: { end: 3.5 } }]);
    assert.deepEqual(editsOf(undo(two)), [{ index: 0, end: 1.5 }]);
    assert.equal(dirtyCount(undo(undo(two))), 0);
  });

  it("deshacer sin nada que deshacer devuelve el mismo estado; un arreglo vacío o de un índice inexistente no crea paso", () => {
    const state = open();
    assert.equal(undo(state), state);
    assert.equal(canUndo(applyFixes(state, [{ index: 9, edit: { end: 3 } }])), false);
    assert.equal(canUndo(applyFixes(state, [{ index: 0, edit: {} }])), false);
  });

  it("un arreglo que deja el valor original no ensucia, pero sí se puede deshacer sin dañar", () => {
    const fixed = applyFixes(open(), [{ index: 0, edit: { end: 2 } }]);
    assert.equal(dirtyCount(fixed), 0);
    assert.equal(dirtyCount(undo(fixed)), 0);
  });

  it("la pila está acotada a 50 pasos", () => {
    let state = open();
    for (let i = 0; i < 60; i += 1) state = applyFixes(state, [{ index: 0, edit: { end: 2.5 + i / 100 } }]);
    let steps = 0;
    while (canUndo(state)) {
      state = undo(state);
      steps += 1;
    }
    assert.equal(steps, 50);
  });

  it("guardar o descartar vacía la pila", () => {
    const fixed = applyFixes(open(), [{ index: 0, edit: { end: 3 } }]);
    assert.equal(canUndo(discard(fixed)), false);
    assert.equal(canUndo(saved(fixed, SEGMENTS, ETAG, editsOf(fixed))), false);
  });
});
