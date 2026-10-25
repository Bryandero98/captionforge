// Catálogo de temas visuales (v1.3.0): forma válida y coherencia con el contrato del quemado.
// Los números de `preview` se comparan con el motor real en python-tests/test_themes_parity.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { ROOT, readSchema } from "../scripts/lib.mjs";

const catalogue = JSON.parse(readFileSync(join(ROOT, "themes.v1.json"), "utf8"));

const COLOUR = "^#[0-9A-F]{6}$";
const NUMBER = { type: "number", minimum: 0, maximum: 1 };
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "default", "themes"],
  properties: {
    $comment: { type: "string" },
    version: { const: 1 },
    default: { type: "string" },
    themes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "group", "burn", "preview"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{2,30}$" },
          group: { enum: ["source", "vertical"] },
          burn: {
            type: "object",
            additionalProperties: false,
            properties: { style: { type: "string" }, template: { type: "string" }, canvas: { const: "vertical" } },
          },
          preview: {
            type: "object",
            additionalProperties: false,
            required: ["font", "bold", "mode", "maxWords", "sizeRatio", "marginRatio", "outlineRatio", "shadowRatio", "upper", "popScale", "base", "lit", "outline", "box", "karaoke"],
            properties: {
              font: { enum: ["arial", "montserrat", "nunito"] },
              bold: { type: "boolean" },
              mode: { enum: ["static", "pop", "sweep", "color"] },
              maxWords: { type: "integer", minimum: 1, maximum: 12 },
              sizeRatio: NUMBER,
              marginRatio: NUMBER,
              outlineRatio: NUMBER,
              shadowRatio: NUMBER,
              upper: { type: "boolean" },
              popScale: { type: "integer", minimum: 100, maximum: 200 },
              base: { type: "string", pattern: COLOUR },
              lit: { type: "string", pattern: COLOUR },
              outline: { type: "string", pattern: COLOUR },
              box: { anyOf: [{ type: "null" }, { type: "string", pattern: "^#[0-9A-F]{8}$" }] },
              karaoke: {
                anyOf: [
                  { type: "null" },
                  { type: "object", additionalProperties: false, required: ["base", "lit"], properties: { base: { type: "string", pattern: COLOUR }, lit: { type: "string", pattern: COLOUR } } },
                ],
              },
            },
          },
        },
      },
    },
  },
};

test("el catálogo cumple su esquema", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(catalogue), true, JSON.stringify(validate.errors));
});

test("ids únicos y el tema por defecto existe", () => {
  const ids = catalogue.themes.map((theme) => theme.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(catalogue.default));
});

test("hay siete temas y cada motor existente aparece exactamente una vez", () => {
  const burn = readSchema("burn-job.v1");
  const common = readSchema("common.v1");
  const styles = common.$defs.StylePreset.enum;
  const templates = burn.properties.options.properties.template.enum;
  assert.equal(catalogue.themes.length, styles.length + templates.length);
  const usedStyles = catalogue.themes.filter((theme) => theme.group === "source").map((theme) => theme.burn.style).sort();
  const usedTemplates = catalogue.themes.filter((theme) => theme.group === "vertical").map((theme) => theme.burn.template).sort();
  assert.deepEqual(usedStyles, [...styles].sort());
  assert.deepEqual(usedTemplates, [...templates].sort());
});

test("lo que cada tema manda al quemado es exactamente lo de siempre", () => {
  for (const theme of catalogue.themes) {
    if (theme.group === "source") assert.deepEqual(Object.keys(theme.burn), ["style"], theme.id);
    else assert.deepEqual(Object.keys(theme.burn).sort(), ["canvas", "template"], theme.id);
  }
});

test("solo los estilos clásicos describen el resaltado palabra por palabra de su karaoke", () => {
  for (const theme of catalogue.themes) {
    assert.equal(theme.preview.karaoke !== null, theme.group === "source", theme.id);
    assert.equal(theme.preview.mode === "static", theme.group === "source", theme.id);
  }
});
