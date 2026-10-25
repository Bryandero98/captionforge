// Perfiles (v1.3.0, iniciativa 1): tabla del cliente que se traduce a las opciones de siempre. Las opciones que producen deben ser válidas
// según los esquemas del contrato (se leen los JSON reales: si cambian, esta prueba lo nota).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { NO_CAPABILITIES } from "../public/js/api/capabilities.js";
import { PROFILES, PROFILE_IDS, followUpFor, optionsFor } from "../public/js/domain/profiles.js";

const schema = (name) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/schemas/${name}`, import.meta.url), "utf8"));
const common = schema("common.v1.json");
const burn = schema("burn-job.v1.json");
const ENUMS = {
  modelSize: common.$defs.ModelSize.enum,
  style: common.$defs.StylePreset.enum,
  template: burn.properties.options.properties.template.enum,
  canvas: burn.properties.options.properties.canvas.enum,
};

const caps = (extra = {}) => ({ ...NO_CAPABILITIES, diarization: { enabled: true }, ...extra });
const facts = (extra = {}) => ({ kind: "video", durationSeconds: 100, width: 1920, height: 1080, ...extra });

describe("tabla de perfiles", () => {
  it("tiene los cinco perfiles aprobados, con Estándar de respaldo", () => {
    assert.deepEqual([...PROFILE_IDS], ["vertical", "podcast", "meeting", "quick-clip", "standard"]);
    assert.deepEqual(Object.keys(PROFILES).sort(), [...PROFILE_IDS].sort());
  });

  it("Estándar equivale exactamente a los valores de hoy: small, autodetectar, sin traducir, sin limpiar, sin hablantes, sin encadenado", () => {
    assert.deepEqual(optionsFor("standard", caps(), facts()), { modelSize: "small", sourceLanguage: "", translateTo: "", cleanAudio: false, diarize: false });
    assert.equal(followUpFor("standard", facts(), caps()), null);
  });

  it("ningún perfil activa solo idioma de origen, traducción ni limpieza de audio (cuestan o cambian el resultado)", () => {
    for (const id of PROFILE_IDS) {
      const options = optionsFor(id, caps(), facts({ kind: id === "podcast" ? "audio" : "video", durationSeconds: 1800 }));
      assert.equal(options.sourceLanguage, "", id);
      assert.equal(options.translateTo, "", id);
      assert.equal(options.cleanAudio, false, id);
    }
  });
});

describe("las opciones producidas son válidas según el contrato", () => {
  it("modelSize, estilo, plantilla y lienzo de cada perfil están en los enums de los esquemas", () => {
    for (const id of PROFILE_IDS) {
      assert.ok(ENUMS.modelSize.includes(optionsFor(id, caps(), facts()).modelSize), id);
      const vertical = id === "vertical";
      const follow = followUpFor(id, facts({ durationSeconds: 60, width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080 }), caps());
      if (follow === null) continue;
      assert.ok(ENUMS.canvas.includes(follow.burn.canvas), id);
      if (follow.burn.template !== undefined) assert.ok(ENUMS.template.includes(follow.burn.template), id);
      if (follow.burn.style !== undefined) assert.ok(ENUMS.style.includes(follow.burn.style), id);
    }
  });
});

describe("hablantes (diarización): solo Podcast y Reunión, menos de 60 min y si el servidor la ofrece", () => {
  for (const id of ["podcast", "meeting"]) {
    it(`${id}: se pide con servidor capaz y duración conocida menor de 60 min`, () => {
      assert.equal(optionsFor(id, caps(), facts({ durationSeconds: 3599 })).diarize, true);
    });
    it(`${id}: no se pide a partir de 60 min, sin duración o sin soporte del servidor`, () => {
      assert.equal(optionsFor(id, caps(), facts({ durationSeconds: 3600 })).diarize, false);
      assert.equal(optionsFor(id, caps(), facts({ durationSeconds: 7200 })).diarize, false);
      assert.equal(optionsFor(id, caps(), facts({ durationSeconds: null })).diarize, false);
      assert.equal(optionsFor(id, NO_CAPABILITIES, facts({ durationSeconds: 1800 })).diarize, false);
    });
  }
  it("los demás perfiles nunca piden hablantes", () => {
    for (const id of ["vertical", "quick-clip", "standard"]) assert.equal(optionsFor(id, caps(), facts({ durationSeconds: 100 })).diarize, false, id);
  });
});

describe("encadenado del quemado (solo lo barato y local)", () => {
  it("Vertical: quema en 9:16 con la primera plantilla disponible, si la duración cabe en el tope del servidor", () => {
    const portrait = facts({ width: 1080, height: 1920, durationSeconds: 48 });
    assert.deepEqual(followUpFor("vertical", portrait, caps()), { burn: { canvas: "vertical", template: "bold-pop" } });
    assert.deepEqual(followUpFor("vertical", portrait, caps({ burn: { templates: ["clean-color"] } })), { burn: { canvas: "vertical", template: "clean-color" } });
  });

  it("Vertical: sin duración conocida o por encima del tope (configurable) no se encadena", () => {
    const portrait = (durationSeconds) => facts({ width: 1080, height: 1920, durationSeconds });
    assert.equal(followUpFor("vertical", portrait(null), caps()), null);
    assert.equal(followUpFor("vertical", portrait(601), caps()), null);
    assert.notEqual(followUpFor("vertical", portrait(600), caps()), null);
    assert.equal(followUpFor("vertical", portrait(100), caps({ limits: { verticalMaxSeconds: 90 } })), null);
  });

  it("Clip rápido: quemado clásico con el estilo moderno; Podcast y Reunión: nada (un audio no se quema; una reunión larga tampoco)", () => {
    assert.deepEqual(followUpFor("quick-clip", facts(), caps()), { burn: { canvas: "source", style: "modern" } });
    assert.equal(followUpFor("podcast", facts({ kind: "audio" }), caps()), null);
    assert.equal(followUpFor("meeting", facts({ durationSeconds: 3000 }), caps()), null);
  });

  it("jamás encadena traducir, doblar ni nada que no sea el quemado", () => {
    for (const id of PROFILE_IDS) {
      const follow = followUpFor(id, facts({ width: 1080, height: 1920, durationSeconds: 60 }), caps());
      if (follow !== null) assert.deepEqual(Object.keys(follow), ["burn"], id);
    }
  });

  it("un id desconocido se trata como Estándar", () => {
    assert.deepEqual(optionsFor("hacker", caps(), facts()), optionsFor("standard", caps(), facts()));
    assert.equal(followUpFor("hacker", facts(), caps()), null);
  });
});
