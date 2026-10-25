// Temas visuales (v1.3.0): del nombre amable a las opciones de siempre de POST /v1/jobs/:id/burn.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CAPABILITIES } from "../public/js/api/capabilities.js";
import { BURN_STYLES, BURN_TEMPLATES } from "../public/js/domain/burn-options.js";
import { DEFAULT_THEME_ID, THEMES, burnRequestOf, followUpOf, groupedThemes, themeById, themeForLegacy, unavailableReason } from "../public/js/domain/themes.js";

describe("catálogo", () => {
  it("tiene los siete temas, uno por cada motor que ya existe", () => {
    assert.equal(THEMES.length, BURN_STYLES.length + BURN_TEMPLATES.length);
    assert.deepEqual(THEMES.filter((t) => t.group === "source").map((t) => t.burn.style).sort(), [...BURN_STYLES].sort());
    assert.deepEqual(THEMES.filter((t) => t.group === "vertical").map((t) => t.burn.template).sort(), [...BURN_TEMPLATES].sort());
  });

  it("el tema por defecto es «Moderno» (el estilo de siempre) y un id desconocido cae a él", () => {
    assert.equal(DEFAULT_THEME_ID, "modern");
    assert.equal(themeById("modern").burn.style, "modern");
    for (const bad of ["nope", "", null, undefined, 3, "__proto__", "constructor"]) assert.equal(themeById(bad).id, "modern", String(bad));
  });

  it("se agrupa en «formato original» y «vertical», en ese orden, sin perder ninguno", () => {
    const groups = groupedThemes();
    assert.deepEqual(groups.map((g) => g.group), ["source", "vertical"]);
    assert.equal(groups.reduce((n, g) => n + g.themes.length, 0), THEMES.length);
  });

  it("el catálogo no se puede alterar desde fuera", () => {
    assert.throws(() => {
      "use strict";
      /** @type {any} */ (THEMES).push({});
    });
    assert.throws(() => {
      "use strict";
      /** @type {any} */ (THEMES[0]).id = "x";
    });
  });
});

describe("lo que se manda al quemado", () => {
  it("un tema clásico manda el estilo y el karaoke, y nada de plantilla ni lienzo", () => {
    assert.deepEqual(burnRequestOf(themeById("tiktok-bold"), { karaoke: true }), { style: "tiktok", karaoke: true });
    assert.deepEqual(burnRequestOf(themeById("minimal-pro"), { karaoke: false }), { style: "minimal", karaoke: false });
  });

  it("un tema vertical manda lienzo y plantilla, sin karaoke (la plantilla ya resalta palabra por palabra)", () => {
    assert.deepEqual(burnRequestOf(themeById("shorts-dynamic"), { karaoke: true }), { canvas: "vertical", template: "bold-pop" });
    assert.deepEqual(burnRequestOf(themeById("soft-rounded"), { karaoke: false }), { canvas: "vertical", template: "rounded-sweep" });
    assert.deepEqual(burnRequestOf(themeById("clean-color"), {}), { canvas: "vertical", template: "clean-color" });
  });

  it("el encadenado de «Sube y olvídate» usa la misma forma que la fase 1", () => {
    assert.deepEqual(followUpOf(themeById("modern")), { burn: { canvas: "source", style: "modern" } });
    assert.deepEqual(followUpOf(themeById("shorts-dynamic")), { burn: { canvas: "vertical", template: "bold-pop" } });
  });
});

describe("migración desde el formato y la plantilla guardados", () => {
  it("cada par antiguo da su tema equivalente", () => {
    assert.equal(themeForLegacy({ format: "classic", style: "youtube" }).id, "classic-youtube");
    assert.equal(themeForLegacy({ format: "classic" }).id, "modern");
    assert.equal(themeForLegacy({ format: "vertical", template: "rounded-sweep" }).id, "soft-rounded");
    assert.equal(themeForLegacy({ format: "vertical" }).id, "shorts-dynamic");
  });

  it("lo desconocido o roto cae al tema por defecto", () => {
    assert.equal(themeForLegacy({ format: "otro", template: "neon" }).id, "modern");
    assert.equal(themeForLegacy({}).id, "modern");
    assert.equal(themeForLegacy(null).id, "modern");
    assert.equal(themeForLegacy({ format: "vertical", template: "neon" }).id, "shorts-dynamic");
  });
});

describe("disponibilidad de un tema", () => {
  const caps = (extra = {}) => ({ ...NO_CAPABILITIES, ...extra });

  it("los temas clásicos siempre están disponibles", () => {
    for (const theme of THEMES.filter((t) => t.group === "source")) assert.equal(unavailableReason(theme, { durationSeconds: 99999, caps: caps() }), null, theme.id);
  });

  it("un vertical se desactiva si el video supera el tope del servidor, y lo dice", () => {
    const theme = themeById("shorts-dynamic");
    assert.deepEqual(unavailableReason(theme, { durationSeconds: 601, caps: caps() }), { code: "vertical_too_long", maxMinutes: 10 });
    assert.equal(unavailableReason(theme, { durationSeconds: 600, caps: caps() }), null);
    assert.deepEqual(unavailableReason(theme, { durationSeconds: 3601, caps: caps({ limits: { verticalMaxSeconds: 3600 } }) }), { code: "vertical_too_long", maxMinutes: 60 });
  });

  it("sin duración conocida no se promete lo contrario: el servidor decide", () => {
    for (const durationSeconds of [null, undefined, 0, -1, Number.NaN]) assert.equal(unavailableReason(themeById("shorts-dynamic"), { durationSeconds, caps: caps() }), null, String(durationSeconds));
  });

  it("una plantilla que el servidor no ofrece se desactiva", () => {
    const only = caps({ burn: { templates: ["bold-pop"] } });
    assert.deepEqual(unavailableReason(themeById("soft-rounded"), { durationSeconds: 30, caps: only }), { code: "template_unavailable" });
    assert.equal(unavailableReason(themeById("shorts-dynamic"), { durationSeconds: 30, caps: only }), null);
  });
});
