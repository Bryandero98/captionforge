import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanAudioStatus } from "../public/js/domain/clean-audio.js";

const job = (options, result) => ({ options, result });

describe("cleanAudioStatus", () => {
  it("pedido y aplicado: limpiado", () => {
    assert.equal(cleanAudioStatus(job({ cleanAudio: true }, { audioCleaned: true })), "cleaned");
  });

  it("pedido pero el worker usó el audio original: respaldo, y se avisa", () => {
    assert.equal(cleanAudioStatus(job({ cleanAudio: true }, { audioCleaned: false })), "fallback");
    assert.equal(cleanAudioStatus(job({ cleanAudio: true }, {})), "fallback"); // un resultado sin el campo no prueba que se limpiara
  });

  it("no pedido: no hay nada que mostrar (ni indicador ni aviso)", () => {
    assert.equal(cleanAudioStatus(job({ cleanAudio: false }, { audioCleaned: false })), "none");
    assert.equal(cleanAudioStatus(job({}, {})), "none");
    assert.equal(cleanAudioStatus(job(null, null)), "none");
  });

  it("limpiado sin que figure la opción (trabajo de otra versión): se muestra como limpiado", () => {
    assert.equal(cleanAudioStatus(job({}, { audioCleaned: true })), "cleaned");
  });

  it("valores raros no se interpretan como verdadero", () => {
    assert.equal(cleanAudioStatus(job({ cleanAudio: "true" }, { audioCleaned: "true" })), "none");
    assert.equal(cleanAudioStatus(null), "none");
    assert.equal(cleanAudioStatus(undefined), "none");
  });
});
