import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTimestamp, segmentsToVtt } from "../public/js/domain/subtitles.js";

describe("formatTimestamp", () => {
  it("horas:minutos:segundos.milésimas con el separador pedido", () => {
    assert.equal(formatTimestamp(0, "."), "00:00:00.000");
    assert.equal(formatTimestamp(3661.5, "."), "01:01:01.500");
    assert.equal(formatTimestamp(3661.5, ","), "01:01:01,500");
  });

  it("redondea a milésimas sin que 59.9996 salga como 00:00:60.000", () => {
    assert.equal(formatTimestamp(59.9996, "."), "00:01:00.000");
  });

  it("valores raros (negativo, NaN, infinito) se tratan como 0", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatTimestamp(bad, "."), "00:00:00.000");
  });

  it("más de 99 horas no corta los dígitos", () => {
    assert.equal(formatTimestamp(100 * 3600, "."), "100:00:00.000");
  });
});

describe("segmentsToVtt", () => {
  it("cabecera WEBVTT y un bloque por subtítulo, con punto decimal", () => {
    const vtt = segmentsToVtt([
      { start: 0, end: 1.5, text: "Hola" },
      { start: 2, end: 3.25, text: "Adiós" },
    ]);
    assert.equal(vtt, "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nHola\n\n2\n00:00:02.000 --> 00:00:03.250\nAdiós\n");
  });

  it("sin subtítulos queda la cabecera sola", () => {
    assert.equal(segmentsToVtt([]), "WEBVTT\n");
  });

  it("escapa &, < y > del texto (WebVTT los interpreta como etiquetas)", () => {
    const vtt = segmentsToVtt([{ start: 0, end: 1, text: "a & b <i>c</i>" }]);
    assert.ok(vtt.includes("a &amp; b &lt;i&gt;c&lt;/i&gt;"));
  });

  it("«-->» dentro del texto no puede parecer una línea de tiempos", () => {
    const vtt = segmentsToVtt([{ start: 0, end: 1, text: "x --> y" }]);
    assert.ok(!/^.*-->.*$/m.test(vtt.split("\n").slice(4).join("\n")));
  });

  it("las líneas en blanco del texto terminarían el bloque: se colapsan", () => {
    const vtt = segmentsToVtt([{ start: 0, end: 1, text: "uno\n\n\ndos" }]);
    assert.ok(vtt.includes("uno\ndos"));
    assert.ok(!vtt.includes("uno\n\n"));
  });

  it("recorta espacios y descarta subtítulos sin texto", () => {
    const vtt = segmentsToVtt([{ start: 0, end: 1, text: "  " }, { start: 1, end: 2, text: " hola " }]);
    assert.equal(vtt, "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhola\n");
  });
});
