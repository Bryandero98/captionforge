// Preferencias no sensibles del navegador (v1.3.0, iniciativa 2): lectura estricta, lista blanca, sin secretos y sin romper si el almacenamiento falla.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PREFS_KEY, clearPrefs, defaultPrefs, loadPrefs, parsePrefs, savePrefs, serializePrefs } from "../public/js/domain/prefs.js";

const DEFAULTS = {
  v: 2,
  autoProfile: true,
  modelSize: "small",
  sourceLanguage: "",
  translateTo: "",
  cleanAudio: false,
  diarize: false,
  burnTheme: "modern",
  burnKaraoke: false,
  autoBurn: false,
};

/** Almacenamiento falso en memoria, con la posibilidad de fallar como el de un modo privado. */
function memory({ failRead = false, failWrite = false, initial = {} } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) {
      if (failRead) throw new DOMException("bloqueado", "SecurityError");
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (failWrite) throw new DOMException("cuota", "QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

describe("valores por defecto", () => {
  it("son los seguros de hoy y no se pueden modificar", () => {
    assert.deepEqual(defaultPrefs(), DEFAULTS);
    assert.ok(Object.isFrozen(defaultPrefs()));
  });

  it("el modo (rápido / control total) NO se recuerda: siempre se abre en rápido", () => {
    assert.equal("mode" in defaultPrefs(), false);
    assert.equal("mode" in parsePrefs(JSON.stringify({ v: 2, mode: "advanced" })), false);
  });
});

describe("parsePrefs: lectura estricta", () => {
  it("sin dato, vacío o no JSON devuelve los valores por defecto", () => {
    for (const raw of [null, undefined, "", "   ", "no es json", "{", "[]", "null", "42", '"texto"']) {
      assert.deepEqual(parsePrefs(raw), DEFAULTS, String(raw));
    }
  });

  it("acepta un objeto válido completo", () => {
    const given = { v: 2, autoProfile: false, modelSize: "medium", sourceLanguage: "es", translateTo: "en", cleanAudio: true, diarize: true, burnTheme: "clean-color", burnKaraoke: true, autoBurn: true };
    assert.deepEqual(parsePrefs(JSON.stringify(given)), given);
  });

  it("descarta campo a campo lo que está fuera de la lista blanca y conserva lo válido", () => {
    const parsed = parsePrefs(JSON.stringify({ v: 2, modelSize: "gigante", sourceLanguage: "ES", translateTo: "en", cleanAudio: "sí", diarize: 1, burnTheme: "neon", burnKaraoke: true, autoBurn: null, autoProfile: "no" }));
    assert.deepEqual(parsed, { ...DEFAULTS, translateTo: "en", burnKaraoke: true });
  });

  it("los códigos de idioma solo pueden ser 2 o 3 letras minúsculas", () => {
    for (const bad of ["e", "españa", "EN", "e1", " en", "en ", "../x", "<b>", "en\n"]) {
      assert.equal(parsePrefs(JSON.stringify({ v: 2, sourceLanguage: bad })).sourceLanguage, "", JSON.stringify(bad));
      assert.equal(parsePrefs(JSON.stringify({ v: 2, translateTo: bad })).translateTo, "", JSON.stringify(bad));
    }
    assert.equal(parsePrefs(JSON.stringify({ v: 2, sourceLanguage: "yue" })).sourceLanguage, "yue");
  });

  it("ignora otra versión: no se interpreta lo que no se conoce", () => {
    for (const v of [0, 3, "2", "1", null, undefined]) {
      assert.deepEqual(parsePrefs(JSON.stringify({ v, modelSize: "medium" })), DEFAULTS, String(v));
    }
  });

  it("descarta las claves desconocidas y no las devuelve", () => {
    const parsed = parsePrefs(JSON.stringify({ v: 2, apiKey: "sk-secreto", baseUrl: "https://x", filename: "a.mp4", __proto__: { admin: true }, constructor: "x" }));
    assert.deepEqual(parsed, DEFAULTS);
    assert.equal(Object.hasOwn(parsed, "apiKey"), false);
    assert.equal(parsed.admin, undefined);
  });

  it("un valor enorme se descarta entero (tope de 2 KiB)", () => {
    const big = JSON.stringify({ v: 2, modelSize: "medium", pad: "x".repeat(3000) });
    assert.ok(big.length > 2048);
    assert.deepEqual(parsePrefs(big), DEFAULTS);
  });

  it("un objeto con prototipo contaminado en el JSON no cambia el resultado", () => {
    const parsed = parsePrefs('{"v":2,"__proto__":{"modelSize":"medium"},"modelSize":"base"}');
    assert.equal(parsed.modelSize, "base");
    assert.equal(({}).modelSize, undefined);
  });
});

describe("migración de la v1 (fase 1: formato y plantilla) a la v2 (tema)", () => {
  const v1 = (extra) => JSON.stringify({ v: 1, ...extra });

  it("el formato y la plantilla de antes dan el tema equivalente y el resto se conserva", () => {
    const parsed = parsePrefs(v1({ modelSize: "medium", translateTo: "en", autoBurn: true, burnFormat: "vertical", burnTemplate: "clean-color", burnKaraoke: true }));
    assert.deepEqual(parsed, { ...DEFAULTS, modelSize: "medium", translateTo: "en", autoBurn: true, burnTheme: "clean-color", burnKaraoke: true });
  });

  it("el formato clásico antiguo era siempre «Moderno»", () => {
    assert.equal(parsePrefs(v1({ burnFormat: "classic", burnTemplate: "bold-pop" })).burnTheme, "modern");
  });

  it("un formato o plantilla rotos caen al tema por defecto sin perder lo demás", () => {
    assert.deepEqual(parsePrefs(v1({ burnFormat: "cuadrado", burnTemplate: "neon", cleanAudio: true })), { ...DEFAULTS, cleanAudio: true });
    assert.equal(parsePrefs(v1({ burnFormat: "vertical", burnTemplate: "neon" })).burnTheme, "shorts-dynamic");
  });

  it("una v1 con un campo de tema se ignora (no existía): el tema sale solo del formato", () => {
    assert.equal(parsePrefs(v1({ burnTheme: "tiktok-bold" })).burnTheme, "modern");
  });

  it("al guardar siempre se escribe la v2, sin los campos antiguos", () => {
    const storage = memory({ initial: { "cf-prefs": v1({ burnFormat: "vertical", burnTemplate: "rounded-sweep" }) } });
    const loaded = loadPrefs(storage);
    assert.equal(loaded.burnTheme, "soft-rounded");
    savePrefs(storage, loaded);
    const written = JSON.parse(storage.data.get("cf-prefs"));
    assert.equal(written.v, 2);
    assert.equal(written.burnTheme, "soft-rounded");
    assert.equal("burnFormat" in written, false);
    assert.equal("burnTemplate" in written, false);
  });
});

describe("serializePrefs", () => {
  it("escribe solo los campos de la lista blanca, versionados, y vuelve a leerse igual", () => {
    const prefs = { ...DEFAULTS, modelSize: "base", translateTo: "fr", apiKey: "sk-no", extra: 1 };
    const text = serializePrefs(prefs);
    assert.ok(!text.includes("sk-no") && !text.includes("extra"));
    assert.ok(text.length < 2048);
    assert.deepEqual(parsePrefs(text), { ...DEFAULTS, modelSize: "base", translateTo: "fr" });
  });

  it("normaliza valores inválidos antes de escribirlos", () => {
    assert.deepEqual(parsePrefs(serializePrefs({ ...DEFAULTS, modelSize: "x", burnTheme: "y" })), DEFAULTS);
  });
});

describe("almacenamiento", () => {
  it("guarda y carga con la clave cf-prefs", () => {
    const storage = memory();
    assert.equal(PREFS_KEY, "cf-prefs");
    assert.equal(savePrefs(storage, { ...DEFAULTS, cleanAudio: true }), true);
    assert.ok(storage.data.has("cf-prefs"));
    assert.deepEqual(loadPrefs(storage), { ...DEFAULTS, cleanAudio: true });
  });

  it("sin almacenamiento (null) todo sigue funcionando con los valores por defecto", () => {
    assert.deepEqual(loadPrefs(null), DEFAULTS);
    assert.equal(savePrefs(null, DEFAULTS), false);
    assert.doesNotThrow(() => clearPrefs(null));
  });

  it("si leer lanza (modo privado, datos bloqueados) devuelve los valores por defecto sin propagar", () => {
    assert.deepEqual(loadPrefs(memory({ failRead: true })), DEFAULTS);
  });

  it("si escribir lanza (cuota) lo dice con false y no propaga", () => {
    assert.equal(savePrefs(memory({ failWrite: true }), DEFAULTS), false);
  });

  it("clearPrefs borra la clave y no toca las demás (clave de API, idioma, historial)", () => {
    const storage = memory({ initial: { "cf-prefs": "{}", "cf-api-key": "k", captionforge_lang: "es" } });
    clearPrefs(storage);
    assert.deepEqual([...storage.data.keys()].sort(), ["captionforge_lang", "cf-api-key"]);
  });

  it("jamás guarda nada que no esté en la lista blanca aunque se lo pasen", () => {
    const storage = memory();
    savePrefs(storage, { ...DEFAULTS, apiKey: "sk-123", baseUrl: "https://llm.example", durationSeconds: 61 });
    const stored = storage.data.get("cf-prefs");
    for (const forbidden of ["sk-123", "llm.example", "61", "apiKey", "baseUrl", "durationSeconds"]) assert.ok(!stored.includes(forbidden), forbidden);
  });
});
