import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readConfig } from "../public/js/config.js";

/** Un documento mínimo: solo lo que readConfig usa. */
const docWith = (metas) => ({
  querySelector: (selector) => {
    const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
    return name !== undefined && name in metas ? { getAttribute: () => metas[name] } : null;
  },
});

describe("readConfig", () => {
  it("sin metas: mismo origen y el máximo por defecto del API (4 GiB)", () => {
    assert.deepEqual(readConfig(docWith({})), { baseUrl: "", maxBytes: 4 * 1024 ** 3 });
  });

  it("lee la base del API y el tamaño máximo de las metas", () => {
    const config = readConfig(docWith({ "cf-api-base": "https://api.ejemplo.com", "cf-max-upload-bytes": "1073741824" }));
    assert.deepEqual(config, { baseUrl: "https://api.ejemplo.com", maxBytes: 1_073_741_824 });
  });

  it("quita la barra final de la base para no producir //v1", () => {
    assert.equal(readConfig(docWith({ "cf-api-base": "https://api.ejemplo.com/" })).baseUrl, "https://api.ejemplo.com");
  });

  it("una base que no es http(s) o relativa se ignora: la interfaz no manda archivos a javascript: ni data:", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x", "//evil.example"]) {
      assert.equal(readConfig(docWith({ "cf-api-base": bad })).baseUrl, "", bad);
    }
  });

  it("un tamaño inválido vuelve al valor por defecto", () => {
    for (const bad of ["abc", "-1", "0", "1.5", ""]) {
      assert.equal(readConfig(docWith({ "cf-max-upload-bytes": bad })).maxBytes, 4 * 1024 ** 3, bad);
    }
  });
});
