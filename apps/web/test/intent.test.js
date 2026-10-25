// Análisis de intención (v1.3.0, iniciativa 1): función pura, tabla ordenada de reglas, siempre con perfil de respaldo y motivo.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES } from "../public/js/api/capabilities.js";
import { THRESHOLDS, analyze, analyzeAll } from "../public/js/domain/intent.js";

const caps = (verticalMaxSeconds = 600) => ({ ...NO_CAPABILITIES, limits: { verticalMaxSeconds } });
const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const NO_PICTURE = { width: null, height: null };
const pick = (facts, c = caps()) => analyze(facts, c).profileId;

describe("analyze: perfil según los metadatos del archivo", () => {
  const table = [
    ["video vertical corto → Vertical", { kind: "video", durationSeconds: 48, ...PORTRAIT }, "vertical"],
    ["video vertical justo en el tope → Vertical", { kind: "video", durationSeconds: 600, ...PORTRAIT }, "vertical"],
    ["video vertical por encima del tope → no es Vertical (no cabría)", { kind: "video", durationSeconds: 601, ...PORTRAIT }, "standard"],
    ["video vertical largo de reunión no se confunde con un Short", { kind: "video", durationSeconds: 3000, ...PORTRAIT }, "standard"],
    ["audio de 5 min exactos → Podcast", { kind: "audio", durationSeconds: 300, ...NO_PICTURE }, "podcast"],
    ["audio de 90 min → Podcast", { kind: "audio", durationSeconds: 5400, ...NO_PICTURE }, "podcast"],
    ["audio de menos de 5 min → Estándar", { kind: "audio", durationSeconds: 299, ...NO_PICTURE }, "standard"],
    ["video horizontal de 20 min exactos → Reunión", { kind: "video", durationSeconds: 1200, ...LANDSCAPE }, "meeting"],
    ["video horizontal de 2 h → Reunión", { kind: "video", durationSeconds: 7200, ...LANDSCAPE }, "meeting"],
    ["video horizontal de 3 min exactos → Estándar", { kind: "video", durationSeconds: 180, ...LANDSCAPE }, "standard"],
    ["video horizontal de 179 s → Clip rápido", { kind: "video", durationSeconds: 179, ...LANDSCAPE }, "quick-clip"],
    ["video cuadrado corto → Clip rápido (no es vertical)", { kind: "video", durationSeconds: 60, width: 1080, height: 1080 }, "quick-clip"],
    ["video horizontal de 10 min → Estándar", { kind: "video", durationSeconds: 600, ...LANDSCAPE }, "standard"],
  ];
  for (const [name, facts, expected] of table) it(name, () => assert.equal(pick(facts), expected));

  it("el 9:16 se decide como en el worker: ancho×16 ≤ alto×9", () => {
    assert.equal(pick({ kind: "video", durationSeconds: 30, width: 1080, height: 1921 }), "vertical");
    assert.equal(pick({ kind: "video", durationSeconds: 30, width: 1080, height: 1919 }), "quick-clip"); // 1080×16 > 1919×9
    assert.equal(pick({ kind: "video", durationSeconds: 30, width: 720, height: 1280 }), "vertical");
    assert.equal(pick({ kind: "video", durationSeconds: 30, width: 1080, height: 1350 }), "quick-clip"); // 4:5
  });

  it("respeta el tope vertical que anuncia el servidor", () => {
    const portrait = { kind: "video", durationSeconds: 100, ...PORTRAIT };
    assert.equal(pick(portrait, caps(90)), "standard");
    assert.equal(pick(portrait, caps(120)), "vertical");
  });
});

describe("analyze: datos que faltan", () => {
  it("sin duración (el navegador no pudo leerla) → Estándar, con el motivo", () => {
    for (const facts of [
      { kind: "video", durationSeconds: null, ...LANDSCAPE },
      { kind: "audio", durationSeconds: null, ...NO_PICTURE },
      { kind: "video", durationSeconds: null, ...PORTRAIT },
    ]) {
      const result = analyze(facts, caps());
      assert.equal(result.profileId, "standard");
      assert.ok(result.reasons.some((reason) => reason.code === "duration_unknown"));
    }
  });

  it("video sin dimensiones pero con duración se trata como horizontal", () => {
    assert.equal(pick({ kind: "video", durationSeconds: 60, ...NO_PICTURE }), "quick-clip");
    assert.equal(pick({ kind: "video", durationSeconds: 3000, ...NO_PICTURE }), "meeting");
  });

  it("valores absurdos (negativos, NaN, cero, infinito, texto) cuentan como desconocidos y nunca lanzan", () => {
    for (const bad of [-5, Number.NaN, 0, Number.POSITIVE_INFINITY, "60", undefined]) {
      assert.equal(analyze({ kind: "video", durationSeconds: bad, ...LANDSCAPE }, caps()).profileId, "standard", String(bad));
    }
    assert.equal(pick({ kind: "video", durationSeconds: 60, width: 0, height: -1 }), "quick-clip");
    assert.doesNotThrow(() => analyze(undefined, undefined));
    assert.doesNotThrow(() => analyze({}, {}));
    assert.equal(analyze({}, {}).profileId, "standard");
  });
});

describe("analyze: motivos", () => {
  it("siempre trae al menos un motivo con código y parámetros enteros para traducir", () => {
    const result = analyze({ kind: "video", durationSeconds: 48.4, ...PORTRAIT }, caps());
    assert.deepEqual(result.reasons[0], { code: "portrait_short", seconds: 48 });
  });

  it("explica por qué un vertical largo no es un Short", () => {
    const result = analyze({ kind: "video", durationSeconds: 900, ...PORTRAIT }, caps());
    assert.deepEqual(result.reasons[0], { code: "portrait_too_long", minutes: 15, maxMinutes: 10 });
  });

  it("los códigos de motivo son un conjunto cerrado", () => {
    const seen = new Set();
    for (const facts of [
      { kind: "video", durationSeconds: 48, ...PORTRAIT },
      { kind: "video", durationSeconds: 900, ...PORTRAIT },
      { kind: "audio", durationSeconds: 1800, ...NO_PICTURE },
      { kind: "audio", durationSeconds: 60, ...NO_PICTURE },
      { kind: "video", durationSeconds: 3000, ...LANDSCAPE },
      { kind: "video", durationSeconds: 60, ...LANDSCAPE },
      { kind: "video", durationSeconds: 400, ...LANDSCAPE },
      { kind: "video", durationSeconds: null, ...LANDSCAPE },
    ]) for (const reason of analyze(facts, caps()).reasons) seen.add(reason.code);
    assert.deepEqual([...seen].sort(), ["audio_long", "audio_short", "clip_short", "duration_unknown", "meeting_long", "portrait_short", "portrait_too_long", "video_medium"]);
  });
});

describe("umbrales y lotes", () => {
  it("los umbrales están en una constante inmutable y única", () => {
    assert.deepEqual({ ...THRESHOLDS }, { podcastMinSeconds: 300, meetingMinSeconds: 1200, quickClipMaxSeconds: 180, diarizeMaxSeconds: 3600 });
    assert.ok(Object.isFrozen(THRESHOLDS));
  });

  it("analyzeAll analiza cada archivo por separado y conserva el orden", () => {
    const list = [
      { kind: "video", durationSeconds: 48, ...PORTRAIT },
      { kind: "audio", durationSeconds: 1800, ...NO_PICTURE },
      { kind: "video", durationSeconds: 3000, ...LANDSCAPE },
    ];
    assert.deepEqual(analyzeAll(list, caps()).map((result) => result.profileId), ["vertical", "podcast", "meeting"]);
    assert.deepEqual(analyzeAll([], caps()), []);
  });
});
