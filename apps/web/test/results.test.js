import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { downloadName } from "../public/js/ui/results.js";

describe("downloadName", () => {
  it("el nombre del video sin extensión y con la nueva", () => {
    assert.equal(downloadName("charla.final.mp4", "vtt"), "charla.final.vtt");
  });

  it("quita caracteres de ruta y de control: no se puede salir de la carpeta de descargas", () => {
    assert.equal(downloadName("../../etc/pas:wd?.mkv", "vtt"), "_.._etc_pas_wd_.vtt");
    assert.ok(!/[\/]/.test(downloadName("a\b/c.mp4", "vtt")));
  });

  it("sin nombre aprovechable usa uno por defecto y acota el largo", () => {
    assert.equal(downloadName("", "vtt"), "captionforge.vtt");
    assert.equal(downloadName(".mp4", "vtt"), "captionforge.vtt");
    assert.ok(downloadName("a".repeat(500) + ".mp4", "vtt").length <= 124);
  });
});

describe("downloadName: nombres peligrosos", () => {
  it("quita marcas de direccion Unicode que invertirian la extension", () => {
    const name = downloadName("reporte\u202Efdp.mp4", "vtt");
    assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/.test(name));
  });

  it("nombres reservados de Windows, puntos y espacios en los extremos", () => {
    assert.equal(downloadName("CON.mp4", "vtt"), "_CON.vtt");
    assert.equal(downloadName("nul", "vtt"), "_nul.vtt");
    assert.equal(downloadName("..  .mp4", "vtt"), "captionforge.vtt");
    assert.equal(downloadName("  hola.  ", "vtt"), "hola.vtt");
  });

  it("acotar el largo no parte un par sustituto (emoji)", () => {
    const name = downloadName("\u{1F600}".repeat(200) + ".mp4", "vtt");
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(name));
    assert.equal(Array.from(name.replace(".vtt", "")).length, 120);
  });
});
