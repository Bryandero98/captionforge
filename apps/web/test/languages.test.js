import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LANGUAGES } from "../public/js/domain/languages.js";

describe("LANGUAGES (generado desde legacy/languages.py)", () => {
  it("todos los códigos pasan la validación del API (/^[a-z]{2,3}$/) y no se repiten", () => {
    const codes = LANGUAGES.map((language) => language.code);
    for (const code of codes) assert.match(code, /^[a-z]{2,3}$/);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("cada idioma tiene nombre y están los básicos", () => {
    for (const { name } of LANGUAGES) assert.ok(name.length > 0);
    const codes = new Set(LANGUAGES.map((language) => language.code));
    for (const code of ["es", "en", "pt", "fr", "de"]) assert.ok(codes.has(code), code);
  });
});
