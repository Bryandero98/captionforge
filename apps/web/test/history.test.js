import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ENTRIES, addEntry, parseHistory, removeEntry } from "../public/js/domain/history.js";

const id = (n) => `6f1d2c3e-1111-4222-8333-${String(n).padStart(12, "0")}`;
const entry = (n, extra = {}) => ({ id: id(n), name: `video${n}.mp4`, kind: "TRANSCRIBE", at: 1_000 + n, ...extra });

describe("parseHistory", () => {
  it("lee una lista bien formada", () => {
    assert.deepEqual(parseHistory(JSON.stringify([entry(1), entry(2)])), [entry(1), entry(2)]);
  });

  it("nada, texto roto o algo que no es una lista dan una lista vacía", () => {
    for (const raw of [null, undefined, "", "{", "null", '{"a":1}', "42"]) assert.deepEqual(parseHistory(raw), []);
  });

  it("descarta entradas inválidas y se queda con las buenas", () => {
    const raw = JSON.stringify([entry(1), { id: "no-uuid", name: "x", kind: "TRANSCRIBE", at: 1 }, { ...entry(2), kind: "OTRO" }, { ...entry(3), name: "" }, { ...entry(4), at: "ayer" }, null, "texto", entry(5)]);
    assert.deepEqual(parseHistory(raw).map((e) => e.id), [id(1), id(5)]);
  });

  it("acota el nombre y los campos extra se ignoran (no se guarda nada de más)", () => {
    const [parsed] = parseHistory(JSON.stringify([{ ...entry(1), name: "a".repeat(400), secreto: "x" }]));
    assert.equal(parsed.name.length, 255);
    assert.equal("secreto" in parsed, false);
  });

  it("quita duplicados y respeta el tope", () => {
    const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => entry(i + 1));
    assert.equal(parseHistory(JSON.stringify([...many, entry(1)])).length, MAX_ENTRIES);
  });

  it("conserva el trabajo de origen de un quemado si es un id válido", () => {
    const [burn] = parseHistory(JSON.stringify([entry(1, { kind: "BURN", parentId: id(9) })]));
    assert.equal(burn.parentId, id(9));
    const [bad] = parseHistory(JSON.stringify([entry(1, { kind: "BURN", parentId: "../x" })]));
    assert.equal(bad.parentId, undefined);
  });
});

describe("addEntry / removeEntry", () => {
  it("lo más nuevo va primero", () => {
    assert.deepEqual(addEntry([entry(1)], entry(2)).map((e) => e.id), [id(2), id(1)]);
  });

  it("un id repetido sube al principio sin duplicarse", () => {
    assert.deepEqual(addEntry([entry(1), entry(2)], entry(2)).map((e) => e.id), [id(2), id(1)]);
  });

  it("al pasar el tope se descarta lo más viejo", () => {
    let list = [];
    for (let i = 1; i <= MAX_ENTRIES + 3; i++) list = addEntry(list, entry(i));
    assert.equal(list.length, MAX_ENTRIES);
    assert.equal(list[0].id, id(MAX_ENTRIES + 3));
    assert.equal(list.some((e) => e.id === id(1)), false);
  });

  it("no modifica la lista original", () => {
    const original = [entry(1)];
    addEntry(original, entry(2));
    assert.equal(original.length, 1);
  });

  it("removeEntry quita por id", () => {
    assert.deepEqual(removeEntry([entry(1), entry(2)], id(1)).map((e) => e.id), [id(2)]);
  });
});

describe("historial: fechas y entradas dudosas", () => {
  it("una fecha fuera del rango de Date se descarta (romperia toLocaleString)", () => {
    assert.deepEqual(parseHistory(JSON.stringify([entry(1, { at: 1e20 })])), []);
  });

  it("addEntry no guarda una entrada con un id que no es UUID", () => {
    assert.deepEqual(addEntry([entry(1)], { id: "xyz", name: "a", kind: "TRANSCRIBE", at: 1 }).map((e) => e.id), [id(1)]);
  });
});
