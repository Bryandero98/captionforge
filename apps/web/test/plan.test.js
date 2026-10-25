// Plan de una subida (v1.3.0): de lo que la persona ve en «Control total» (o del perfil sugerido) a las opciones reales de un archivo.
// Función pura. Es el único sitio donde se decide qué se sube y qué se encadena.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES } from "../public/js/api/capabilities.js";
import { planFor } from "../public/js/domain/plan.js";

const caps = (extra = {}) => ({ ...NO_CAPABILITIES, diarization: { enabled: true }, ...extra });
const PORTRAIT = { kind: "video", durationSeconds: 48, width: 1080, height: 1920 };
const LANDSCAPE_LONG = { kind: "video", durationSeconds: 1800, width: 1920, height: 1080 };
const CONTROLS = { modelSize: "small", sourceLanguage: "", translateTo: "", cleanAudio: false, diarize: false, autoBurn: false, burnTheme: "modern" };
const entry = (facts) => ({ facts });

describe("planFor: perfil automático", () => {
  it("usa el perfil sugerido para ese archivo: opciones y encadenado", () => {
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: false, controls: CONTROLS }, caps());
    assert.equal(plan.profileId, "vertical");
    assert.equal(plan.source, "auto");
    assert.deepEqual(plan.options, { modelSize: "small", sourceLanguage: "", translateTo: "", cleanAudio: false, diarize: false });
    assert.deepEqual(plan.followUp, { burn: { canvas: "vertical", template: "bold-pop" } });
  });

  it("una reunión larga pide hablantes si el servidor los ofrece, sin encadenar nada", () => {
    const plan = planFor(entry(LANDSCAPE_LONG), { profileChoice: "auto", manual: false, controls: CONTROLS }, caps());
    assert.equal(plan.profileId, "meeting");
    assert.equal(plan.options.diarize, true);
    assert.equal(plan.followUp, null);
  });

  it("un archivo sin analizar (la lectura aún no terminó) se trata como Estándar: lo de siempre", () => {
    const plan = planFor({ facts: null }, { profileChoice: "auto", manual: false, controls: CONTROLS }, caps());
    assert.equal(plan.profileId, "standard");
    assert.equal(plan.followUp, null);
    assert.equal(plan.options.modelSize, "small");
  });
});

describe("planFor: perfil elegido a mano", () => {
  it("un perfil fijo se aplica a todos los archivos, sea cual sea su análisis", () => {
    const plan = planFor(entry(LANDSCAPE_LONG), { profileChoice: "quick-clip", manual: false, controls: CONTROLS }, caps());
    assert.equal(plan.profileId, "quick-clip");
    assert.equal(plan.source, "profile");
    assert.deepEqual(plan.followUp, { burn: { canvas: "source", style: "modern" } });
  });

  it("un perfil desconocido cae a Estándar", () => {
    assert.equal(planFor(entry(PORTRAIT), { profileChoice: "hacker", manual: false, controls: CONTROLS }, caps()).profileId, "standard");
  });
});

describe("planFor: ajustes manuales de «Control total»", () => {
  it("mandan los controles, para todos los archivos, y no hay perfil", () => {
    const controls = { ...CONTROLS, modelSize: "medium", sourceLanguage: "es", translateTo: "en", cleanAudio: true, diarize: true };
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls }, caps());
    assert.equal(plan.source, "manual");
    assert.equal(plan.profileId, null);
    assert.deepEqual(plan.options, { modelSize: "medium", sourceLanguage: "es", translateTo: "en", cleanAudio: true, diarize: true });
    assert.equal(plan.followUp, null, "sin «crear el video al terminar» no se encadena nada, aunque el perfil sugerido lo hiciera");
  });

  it("hablantes sin soporte del servidor no se piden aunque la casilla esté marcada", () => {
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, diarize: true } }, NO_CAPABILITIES);
    assert.equal(plan.options.diarize, false);
  });

  it("«crear el video al terminar» encadena el quemado con el formato y la plantilla elegidos", () => {
    const classic = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, autoBurn: true } }, caps());
    assert.deepEqual(classic.followUp, { burn: { canvas: "source", style: "modern" } });
    const vertical = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, autoBurn: true, burnTheme: "clean-color" } }, caps());
    assert.deepEqual(vertical.followUp, { burn: { canvas: "vertical", template: "clean-color" } });
  });

  it("un tema clásico encadena su propio estilo, no siempre «moderno»", () => {
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, autoBurn: true, burnTheme: "tiktok-bold" } }, caps());
    assert.deepEqual(plan.followUp, { burn: { canvas: "source", style: "tiktok" } });
  });

  it("un tema cuya plantilla el servidor no ofrece no se encadena y lo dice", () => {
    const only = caps({ burn: { templates: ["bold-pop"] } });
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, autoBurn: true, burnTheme: "soft-rounded" } }, only);
    assert.equal(plan.followUp, null);
    assert.deepEqual(plan.notes, ["template_unavailable"]);
  });

  it("un tema desconocido cae al tema por defecto", () => {
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, autoBurn: true, burnTheme: "neon" } }, caps());
    assert.deepEqual(plan.followUp, { burn: { canvas: "source", style: "modern" } });
  });

  it("vertical con una duración conocida por encima del tope no se encadena y lo dice", () => {
    const controls = { ...CONTROLS, autoBurn: true, burnTheme: "shorts-dynamic" };
    const plan = planFor(entry({ ...PORTRAIT, durationSeconds: 601 }), { profileChoice: "auto", manual: true, controls }, caps());
    assert.equal(plan.followUp, null);
    assert.deepEqual(plan.notes, ["vertical_too_long"]);
    const unknown = planFor(entry({ ...PORTRAIT, durationSeconds: null }), { profileChoice: "auto", manual: true, controls }, caps());
    assert.notEqual(unknown.followUp, null, "sin duración conocida el servidor decide (413 con mensaje claro)");
  });

  it("un audio nunca encadena el quemado (no tiene imagen)", () => {
    const plan = planFor(entry({ kind: "audio", durationSeconds: 900, width: null, height: null }), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, autoBurn: true } }, caps());
    assert.equal(plan.followUp, null);
  });

  it("valores raros de los controles se corrigen a los de siempre", () => {
    const plan = planFor(entry(PORTRAIT), { profileChoice: "auto", manual: true, controls: { ...CONTROLS, modelSize: "gigante", sourceLanguage: "ESPAÑA", translateTo: "<b>" } }, caps());
    assert.equal(plan.options.modelSize, "small");
    assert.equal(plan.options.sourceLanguage, "");
    assert.equal(plan.options.translateTo, "");
  });
});
