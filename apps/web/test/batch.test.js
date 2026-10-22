import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { MAX_FILES, addFiles, currentOf, emptyBatch, markCancelled, markDone, markError, markUploading, removeItem, summaryOf } from "../public/js/domain/batch.js";

const file = (name, size = 100) => ({ name, size });
const ok = () => null;
const bad = (code) => (candidate) => (candidate.name.endsWith(".txt") ? ApiError.local(code) : null);

describe("addFiles", () => {
  it("añade en orden como pendientes y numera cada uno", () => {
    const { batch, rejected, overflow } = addFiles(emptyBatch, [file("a.mp4"), file("b.mp4")], ok);
    assert.deepEqual(batch.items.map((item) => [item.file.name, item.status]), [["a.mp4", "pending"], ["b.mp4", "pending"]]);
    assert.notEqual(batch.items[0].key, batch.items[1].key);
    assert.deepEqual(rejected, []);
    assert.equal(overflow, 0);
  });

  it("los inválidos no entran y se devuelven con su motivo", () => {
    const { batch, rejected } = addFiles(emptyBatch, [file("a.mp4"), file("notas.txt")], bad("unsupported_type"));
    assert.equal(batch.items.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].name, "notas.txt");
    assert.equal(rejected[0].problem.code, "unsupported_type");
  });

  it("respeta el máximo de archivos y cuenta lo que sobra", () => {
    const many = Array.from({ length: MAX_FILES + 3 }, (_, i) => file(`v${i}.mp4`));
    const { batch, overflow } = addFiles(emptyBatch, many, ok);
    assert.equal(batch.items.length, MAX_FILES);
    assert.equal(overflow, 3);
  });

  it("añadir sobre una cola existente conserva lo anterior y no repite las claves", () => {
    const first = addFiles(emptyBatch, [file("a.mp4")], ok).batch;
    const second = addFiles(first, [file("b.mp4")], ok).batch;
    assert.deepEqual(second.items.map((item) => item.file.name), ["a.mp4", "b.mp4"]);
    assert.equal(new Set(second.items.map((item) => item.key)).size, 2);
  });

  it("el mismo archivo (nombre y tamaño) dos veces se ignora", () => {
    const { batch, duplicates } = addFiles(addFiles(emptyBatch, [file("a.mp4", 5)], ok).batch, [file("a.mp4", 5), file("a.mp4", 6)], ok);
    assert.equal(batch.items.length, 2);
    assert.equal(duplicates, 1);
  });
});

describe("currentOf: el archivo que toca", () => {
  it("el que sube; si no, el primero pendiente o con fallo; si no, nada", () => {
    let batch = addFiles(emptyBatch, [file("a.mp4"), file("b.mp4"), file("c.mp4")], ok).batch;
    assert.equal(currentOf(batch).file.name, "a.mp4");
    batch = markUploading(batch, batch.items[0].key);
    assert.equal(currentOf(batch).file.name, "a.mp4");
    batch = markDone(batch, batch.items[0].key, "id-1");
    assert.equal(currentOf(batch).file.name, "b.mp4");
    batch = markError(markUploading(batch, batch.items[1].key), batch.items[1].key, ApiError.network());
    assert.equal(currentOf(batch).file.name, "b.mp4"); // el fallo va antes que el pendiente siguiente: se reintenta primero
    batch = removeItem(batch, batch.items[1].key);
    batch = markDone(markUploading(batch, batch.items[1].key), batch.items[1].key, "id-3");
    assert.equal(currentOf(batch), null);
  });
});

describe("transiciones", () => {
  it("done guarda el id del trabajo; error guarda el problema; cancelado queda reintentable", () => {
    let batch = addFiles(emptyBatch, [file("a.mp4"), file("b.mp4"), file("c.mp4")], ok).batch;
    const [a, b, c] = batch.items;
    batch = markDone(markUploading(batch, a.key), a.key, "id-a");
    batch = markError(markUploading(batch, b.key), b.key, ApiError.network());
    batch = markCancelled(markUploading(batch, c.key), c.key);
    assert.equal(batch.items[0].jobId, "id-a");
    assert.equal(batch.items[1].problem.code, "network");
    assert.equal(batch.items[2].status, "cancelled");
    assert.deepEqual(summaryOf(batch), { total: 3, done: 1, failed: 1, pending: 0, cancelled: 1, uploading: 0 });
  });

  it("volver a subir un fallo lo deja subiendo y borra el problema", () => {
    let batch = addFiles(emptyBatch, [file("a.mp4")], ok).batch;
    const key = batch.items[0].key;
    batch = markError(markUploading(batch, key), key, ApiError.network());
    batch = markUploading(batch, key);
    assert.equal(batch.items[0].status, "uploading");
    assert.equal(batch.items[0].problem, null);
  });

  it("solo se sube uno a la vez: marcar otro como subiendo mientras hay uno no cambia nada", () => {
    let batch = addFiles(emptyBatch, [file("a.mp4"), file("b.mp4")], ok).batch;
    batch = markUploading(batch, batch.items[0].key);
    const same = markUploading(batch, batch.items[1].key);
    assert.equal(same, batch);
  });

  it("removeItem no quita el que está subiendo", () => {
    let batch = addFiles(emptyBatch, [file("a.mp4"), file("b.mp4")], ok).batch;
    batch = markUploading(batch, batch.items[0].key);
    assert.equal(removeItem(batch, batch.items[0].key), batch);
    assert.equal(removeItem(batch, batch.items[1].key).items.length, 1);
  });

  it("una clave que no existe no rompe nada", () => {
    const batch = addFiles(emptyBatch, [file("a.mp4")], ok).batch;
    assert.equal(markDone(batch, 999, "x"), batch);
    assert.equal(markError(batch, 999, ApiError.network()), batch);
  });

  it("es inmutable", () => {
    const batch = addFiles(emptyBatch, [file("a.mp4")], ok).batch;
    markUploading(batch, batch.items[0].key);
    assert.equal(batch.items[0].status, "pending");
  });
});
