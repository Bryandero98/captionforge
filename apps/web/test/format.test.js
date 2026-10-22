import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBytes, formatDuration } from "../public/js/domain/format.js";

describe("formatBytes", () => {
  const cases = [
    [0, "es", "0 B"],
    [512, "es", "512 B"],
    [1024, "es", "1 KB"],
    [1536, "es", "1,5 KB"],
    [1536, "en", "1.5 KB"],
    [5 * 1024 ** 2, "en", "5 MB"],
    [123_456_789, "es", "117,7 MB"],
    [4 * 1024 ** 3, "en", "4 GB"],
    [1.5 * 1024 ** 3, "es", "1,5 GB"],
  ];
  for (const [bytes, lang, expected] of cases) {
    it(`${bytes} (${lang}) -> ${expected}`, () => assert.equal(formatBytes(bytes, lang), expected));
  }

  it("los valores raros no rompen: negativo, NaN e infinito caen en 0 B", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatBytes(bad, "es"), "0 B");
  });
});

describe("formatDuration", () => {
  const cases = [
    [0, "0 s"],
    [0.4, "1 s"],
    [45, "45 s"],
    [59.6, "1 min"],
    [60, "1 min"],
    [80, "1 min 20 s"],
    [3599, "59 min 59 s"],
    [3600, "1 h"],
    [3725, "1 h 2 min"],
  ];
  for (const [seconds, expected] of cases) {
    it(`${seconds} s -> ${expected}`, () => assert.equal(formatDuration(seconds), expected));
  }

  it("null, negativo o infinito -> cadena vacía (no hay estimación que mostrar)", () => {
    for (const bad of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatDuration(bad), "");
  });
});
