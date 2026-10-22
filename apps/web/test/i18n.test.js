import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTranslator, detectLang } from "../public/js/i18n/index.js";

describe("createTranslator", () => {
  it("traduce por idioma", () => {
    assert.equal(createTranslator("es")("action.cancel"), "Cancelar");
    assert.equal(createTranslator("en")("action.cancel"), "Cancel");
  });

  it("sustituye {parámetros}, también repetidos y numéricos", () => {
    const t = createTranslator("es");
    assert.equal(t("upload.uploading", { percent: 40 }), "Subiendo… 40 %");
    assert.equal(t("error.busy", { seconds: 10 }), "El servidor está ocupado. Reintenta en 10 s.");
  });

  it("un parámetro que falta se deja visible en lugar de borrarse: es un fallo de quien llama", () => {
    assert.equal(createTranslator("es")("upload.uploading"), "Subiendo… {percent} %");
  });

  it("una clave que no existe devuelve la clave (nunca una cadena vacía ni un error)", () => {
    assert.equal(createTranslator("en")("no.existe"), "no.existe");
  });

  it("un idioma desconocido usa español", () => {
    assert.equal(createTranslator("fr")("action.cancel"), "Cancelar");
  });

  it("los valores no se interpretan como HTML ni como otra plantilla (no hay inyección por parámetros)", () => {
    const text = createTranslator("es")("upload.jobId", { id: "{percent}<b>x</b>" });
    assert.equal(text, "Trabajo {percent}<b>x</b>");
  });
});

describe("detectLang", () => {
  it("usa el idioma guardado si es válido", () => {
    assert.equal(detectLang("en", ["es-CO"]), "en");
  });

  it("ignora un valor guardado que no es es/en", () => {
    assert.equal(detectLang("fr", ["en-US"]), "en");
    assert.equal(detectLang("<script>", ["es"]), "es");
  });

  it("sin guardado, el primer idioma del navegador que conozcamos", () => {
    assert.equal(detectLang(null, ["fr-FR", "en-GB", "es"]), "en");
    assert.equal(detectLang(null, ["es-CO"]), "es");
  });

  it("sin nada conocido, español", () => {
    assert.equal(detectLang(null, ["fr", "de"]), "es");
    assert.equal(detectLang(null, []), "es");
    assert.equal(detectLang(undefined, undefined), "es");
  });
});
