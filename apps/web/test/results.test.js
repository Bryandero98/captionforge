import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { downloadName } from "../public/js/ui/results.js";

describe("downloadName", () => {
  it("el nombre del video sin extensión y con la nueva", () => {
    assert.equal(downloadName("charla.final.mp4", "vtt"), "charla.final.vtt");
  });

  it("quita caracteres de ruta y de control: no se puede salir de la carpeta de descargas", () => {
    assert.equal(downloadName("../../etc/pas:wd?.mkv", "vtt"), ".._.._etc_pas_wd_.vtt");
    assert.ok(!/[\/]/.test(downloadName("a\b/c.mp4", "vtt")));
  });

  it("sin nombre aprovechable usa uno por defecto y acota el largo", () => {
    assert.equal(downloadName("", "vtt"), "captionforge.vtt");
    assert.equal(downloadName(".mp4", "vtt"), "captionforge.vtt");
    assert.ok(downloadName("a".repeat(500) + ".mp4", "vtt").length <= 124);
  });
});
