// Vista previa de un tema (v1.3.0): de los datos del catálogo a variables CSS y al estado de cada palabra. Funciones puras.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { themeById } from "../public/js/domain/themes.js";
import { FONT_STACKS, previewStyle, previewWords, wordStates } from "../public/js/domain/theme-preview.js";

describe("previewStyle: variables CSS", () => {
  it("«Shorts dinámico»: Montserrat pesada, mayúsculas, la palabra activa crece un 20 % y el contorno es grueso", () => {
    const { vars, mode } = previewStyle(themeById("shorts-dynamic"), {});
    assert.equal(mode, "pop");
    assert.equal(vars["--cf-font"], FONT_STACKS.montserrat);
    assert.equal(vars["--cf-weight"], "800");
    assert.equal(vars["--cf-transform"], "uppercase");
    assert.equal(vars["--cf-pop"], "1.2");
    assert.equal(vars["--cf-size"], "0.052");
    assert.equal(vars["--cf-margin"], "0.2");
    assert.equal(vars["--cf-outline"], "0.004");
    assert.equal(vars["--cf-lit"], "#FFE500");
    assert.equal(vars["--cf-base"], "#FFFFFF");
    assert.equal(vars["--cf-box"], "transparent");
  });

  it("«Clásico YouTube»: Arial normal, sin contorno, con caja semitransparente", () => {
    const { vars, mode } = previewStyle(themeById("classic-youtube"), {});
    assert.equal(mode, "static");
    assert.equal(vars["--cf-font"], FONT_STACKS.arial);
    assert.equal(vars["--cf-weight"], "400");
    assert.equal(vars["--cf-transform"], "none");
    assert.equal(vars["--cf-outline"], "0");
    assert.equal(vars["--cf-box"], "#0000007F");
  });

  it("con karaoke, un clásico pasa a barrido con los colores del karaoke; sin él, se queda estático", () => {
    const off = previewStyle(themeById("tiktok-bold"), { karaoke: false });
    const on = previewStyle(themeById("tiktok-bold"), { karaoke: true });
    assert.equal(off.mode, "static");
    assert.equal(on.mode, "sweep");
    assert.equal(on.vars["--cf-base"], "#FFD700");
    assert.equal(on.vars["--cf-lit"], "#FFFFFF");
  });

  it("el karaoke no cambia un tema vertical (la plantilla ya lo lleva)", () => {
    assert.deepEqual(previewStyle(themeById("soft-rounded"), { karaoke: true }), previewStyle(themeById("soft-rounded"), { karaoke: false }));
  });

  it("todas las variables son texto sin comillas ni punto y coma (no pueden abrir otra declaración)", () => {
    for (const id of ["modern", "classic-youtube", "shorts-dynamic", "soft-rounded", "clean-color", "minimal-pro", "tiktok-bold"]) {
      for (const [name, value] of Object.entries(previewStyle(themeById(id), { karaoke: true }).vars)) {
        assert.match(name, /^--cf-[a-z-]+$/);
        assert.equal(typeof value, "string");
        assert.doesNotMatch(value.replace(FONT_STACKS.arial, "").replace(FONT_STACKS.montserrat, "").replace(FONT_STACKS.nunito, ""), /[;{}<>]/, `${id} ${name}`);
      }
    }
  });
});

describe("previewWords: el texto de la persona", () => {
  it("toma las primeras palabras que cabrían en pantalla en ese tema", () => {
    assert.deepEqual(previewWords(themeById("shorts-dynamic"), "Hola a todos los que me ven hoy"), ["Hola", "a", "todos"]);
    assert.deepEqual(previewWords(themeById("soft-rounded"), "Hola a todos los que me ven hoy"), ["Hola", "a", "todos", "los"]);
    assert.equal(previewWords(themeById("modern"), "uno dos tres cuatro cinco seis siete ocho nueve diez").length, 8);
  });

  it("quita etiquetas de formato y espacios sobrantes (Whisper entrega « Hola»)", () => {
    assert.deepEqual(previewWords(themeById("modern"), "  <b>Hola</b>   &   <i>mundo</i> "), ["Hola", "&", "mundo"]);
  });

  it("sin texto usa el de muestra, y un texto que no sea cadena no rompe", () => {
    assert.deepEqual(previewWords(themeById("modern"), "", ["Tus", "subtítulos"]), ["Tus", "subtítulos"]);
    assert.deepEqual(previewWords(themeById("modern"), null, ["Muestra"]), ["Muestra"]);
    assert.deepEqual(previewWords(themeById("modern"), undefined), []);
  });
});

describe("wordStates: qué palabra está activa en cada instante", () => {
  it("estático: nada se mueve", () => {
    assert.deepEqual(wordStates("static", 3, 5), ["idle", "idle", "idle"]);
  });

  it("pop y color: solo la palabra activa se enciende, y el ciclo da la vuelta", () => {
    assert.deepEqual(wordStates("pop", 3, 0), ["active", "idle", "idle"]);
    assert.deepEqual(wordStates("color", 3, 1), ["idle", "active", "idle"]);
    assert.deepEqual(wordStates("pop", 3, 3), ["active", "idle", "idle"]);
  });

  it("barrido: las ya dichas quedan encendidas, la activa avanza y el resto espera", () => {
    assert.deepEqual(wordStates("sweep", 4, 2), ["sung", "sung", "active", "idle"]);
    assert.deepEqual(wordStates("sweep", 4, 0), ["active", "idle", "idle", "idle"]);
  });

  it("sin palabras, nada; con un tick raro (negativo, NaN) se trata como 0", () => {
    assert.deepEqual(wordStates("pop", 0, 3), []);
    assert.deepEqual(wordStates("pop", 2, -5), ["active", "idle"]);
    assert.deepEqual(wordStates("pop", 2, Number.NaN), ["active", "idle"]);
  });

  it("movimiento reducido: una foto fija con la primera palabra encendida (o todas las dichas en barrido)", () => {
    assert.deepEqual(wordStates("pop", 3, 7, { reduced: true }), ["active", "idle", "idle"]);
    assert.deepEqual(wordStates("sweep", 3, 7, { reduced: true }), ["sung", "sung", "sung"]);
    assert.deepEqual(wordStates("static", 3, 7, { reduced: true }), ["idle", "idle", "idle"]);
  });
});
