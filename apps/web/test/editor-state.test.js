import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dirtyCount, editsOf, issuesOf, openEditor, saved, setText, setTime, discard } from "../public/js/domain/editor-state.js";

const ETAG = "a".repeat(32);
const seg = (index, start, end, text) => ({ index, start, end, text, words: null });
const SEGMENTS = [seg(0, 0, 2, " Hola"), seg(1, 2, 4, " Mundo"), seg(2, 4, 6, " Fin")];
const open = () => openEditor(SEGMENTS, ETAG);

describe("editor de subtítulos: estado", () => {
  it("al abrir no hay cambios ni envíos pendientes", () => {
    const state = open();
    assert.equal(dirtyCount(state), 0);
    assert.deepEqual(editsOf(state), []);
    assert.equal(state.etag, ETAG);
  });

  it("cambiar un texto genera una edición solo de ese campo", () => {
    const state = setText(open(), 1, "Mundo cruel");
    assert.equal(dirtyCount(state), 1);
    assert.deepEqual(editsOf(state), [{ index: 1, text: "Mundo cruel" }]);
  });

  it("volver al valor original deshace el cambio (no queda sucio)", () => {
    const state = setText(setText(open(), 0, "otro"), 0, " Hola");
    assert.equal(dirtyCount(state), 0);
    assert.deepEqual(editsOf(state), []);
  });

  it("cambiar tiempos manda solo el campo que cambió", () => {
    const state = setTime(open(), 2, "start", 4.5);
    assert.deepEqual(editsOf(state), [{ index: 2, start: 4.5 }]);
  });

  it("texto y tiempos del mismo subtítulo van en una sola edición, ordenadas por índice", () => {
    let state = setTime(open(), 2, "end", 7);
    state = setText(state, 0, "Buenas");
    state = setTime(state, 0, "end", 1.5);
    assert.deepEqual(editsOf(state), [{ index: 0, text: "Buenas", end: 1.5 }, { index: 2, end: 7 }]);
    assert.equal(dirtyCount(state), 2);
  });

  it("no modifica el estado anterior (inmutable)", () => {
    const before = open();
    setText(before, 0, "x");
    assert.equal(dirtyCount(before), 0);
  });

  it("un índice que no existe se ignora", () => {
    assert.equal(dirtyCount(setText(open(), 99, "x")), 0);
  });

  it("descartar vuelve a lo guardado", () => {
    assert.equal(dirtyCount(discard(setText(open(), 0, "x"))), 0);
  });

  it("al guardar se adopta lo que devuelve el servidor y el etag nuevo", () => {
    const edited = setText(open(), 0, "Buenas");
    const next = saved(edited, [seg(0, 0, 2, "Buenas"), ...SEGMENTS.slice(1)], "b".repeat(32));
    assert.equal(dirtyCount(next), 0);
    assert.equal(next.etag, "b".repeat(32));
    assert.equal(next.segments[0].text, "Buenas");
  });

  it("un cambio hecho mientras se guardaba sigue pendiente tras guardar", () => {
    const sent = setText(open(), 0, "Buenas");
    const later = setText(sent, 1, "Tierra");
    const next = saved(later, [seg(0, 0, 2, "Buenas"), ...SEGMENTS.slice(1)], "b".repeat(32), editsOf(sent));
    assert.deepEqual(editsOf(next), [{ index: 1, text: "Tierra" }]);
  });
});

describe("issuesOf: validación antes de enviar", () => {
  it("un inicio que no es menor que el fin es un problema de ese subtítulo", () => {
    const state = setTime(open(), 0, "start", 2);
    assert.deepEqual(issuesOf(state), { 0: "range" });
  });

  it("tiempos negativos o no finitos son un problema", () => {
    assert.deepEqual(issuesOf(setTime(open(), 1, "start", -1)), { 1: "range" });
    assert.deepEqual(issuesOf(setTime(open(), 1, "end", Number.NaN)), { 1: "range" });
  });

  it("un texto demasiado largo es un problema (el servidor admite 2000 caracteres)", () => {
    assert.deepEqual(issuesOf(setText(open(), 2, "x".repeat(2001))), { 2: "long" });
    assert.deepEqual(issuesOf(setText(open(), 2, "x".repeat(2000))), {});
  });

  it("sin cambios o con cambios válidos no hay problemas", () => {
    assert.deepEqual(issuesOf(open()), {});
    assert.deepEqual(issuesOf(setText(open(), 0, "Hola de nuevo")), {});
  });

  it("solo se revisan los subtítulos editados", () => {
    // Un subtítulo con tiempos raros que viene del servidor no bloquea guardar otro.
    const odd = openEditor([seg(0, 5, 5, "raro"), seg(1, 5, 6, "bien")], ETAG);
    assert.deepEqual(issuesOf(setText(odd, 1, "mejor")), {});
  });
});

describe("editor: casos de la revision", () => {
  it("volver al valor original MIENTRAS se guarda deja ese retroceso pendiente (el servidor ya tiene el valor enviado)", () => {
    const sent = setText(open(), 0, "B");
    const reverted = setText(sent, 0, " Hola"); // el usuario escribe de nuevo el original durante el guardado
    assert.equal(dirtyCount(reverted), 0);
    const next = saved(reverted, [seg(0, 0, 2, "B"), ...SEGMENTS.slice(1)], "b".repeat(32), editsOf(sent));
    assert.deepEqual(editsOf(next), [{ index: 0, text: " Hola" }]);
  });

  it("lo mismo con un tiempo", () => {
    const sent = setTime(open(), 1, "end", 5);
    const reverted = setTime(sent, 1, "end", 4);
    const next = saved(reverted, [SEGMENTS[0], seg(1, 2, 5, " Mundo"), SEGMENTS[2]], "b".repeat(32), editsOf(sent));
    assert.deepEqual(editsOf(next), [{ index: 1, end: 4 }]);
  });

  it("una linea en blanco en el texto es un problema ('blank'); una sola salto de linea no", () => {
    assert.deepEqual(issuesOf(setText(open(), 0, "uno\n\ndos")), { 0: "blank" });
    assert.deepEqual(issuesOf(setText(open(), 0, "uno\n \ndos")), { 0: "blank" });
    assert.deepEqual(issuesOf(setText(open(), 0, "uno\ndos")), {});
  });

  it("un tiempo por encima del maximo del servidor es un problema de rango", () => {
    assert.deepEqual(issuesOf(setTime(open(), 2, "end", 1_000_001)), { 2: "range" });
    assert.deepEqual(issuesOf(setTime(open(), 2, "end", 1_000_000)), {});
  });
});
