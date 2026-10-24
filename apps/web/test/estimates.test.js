// Guía de consumo para quien usa su propia cuenta de IA: cuántos caracteres (y tokens) suelen ser 15, 30, 45 y 60 s de habla.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { estimateTokens, SUGGESTED_ESTIMATES } from "../public/js/domain/spend.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createSpendConfirm } from "../public/js/ui/spend-confirm.js";
import { FakeDialog, FakeElement } from "./helpers/fake-dom.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const LANGS = ["es", "en", "de", "fr", "it", "pt"];

describe("estimaciones sugeridas", () => {
  it("15, 30, 45 y 60 s equivalen a 200, 400, 600 y 800 caracteres", () => {
    assert.deepEqual(
      SUGGESTED_ESTIMATES.map(({ seconds, characters }) => [seconds, characters]),
      [[15, 200], [30, 400], [45, 600], [60, 800]],
    );
  });

  it("los tokens salen de caracteres ÷ 4 redondeado hacia arriba (50, 100, 150, 200)", () => {
    assert.deepEqual(SUGGESTED_ESTIMATES.map(({ tokens }) => tokens), [50, 100, 150, 200]);
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(5), 2);
    assert.equal(estimateTokens(-3), 0);
    assert.equal(estimateTokens(Number.NaN), 0);
  });

  it("la tabla de la página repite exactamente esas cifras, en la guía y en el panel de claves", () => {
    const tables = [...html.matchAll(/<table class="estimates"[\s\S]*?<\/table>/g)].map((match) => match[0]);
    assert.equal(tables.length, 2);
    for (const table of tables) {
      const rows = [...table.matchAll(/<tbody>[\s\S]*?<\/tbody>/g)][0][0].match(/<tr>[\s\S]*?<\/tr>/g).map((row) => [...row.matchAll(/<t[dh][^>]*>(\d+)<\/t[dh]>/g)].map((cell) => Number(cell[1])));
      assert.deepEqual(rows, SUGGESTED_ESTIMATES.map(({ seconds, characters, tokens }) => [seconds, characters, tokens]));
    }
  });

  for (const lang of LANGS) {
    it(`[${lang}] los textos de la guía y de la tabla existen y avisan de que son estimaciones`, () => {
      const t = createTranslator(lang);
      for (const key of ["guide.s7.title", "guide.s7.body", "estimates.caption", "estimates.seconds", "estimates.characters", "estimates.tokens", "estimates.note"]) {
        assert.notEqual(t(key), key, `${lang}: falta ${key}`);
      }
      assert.match(t("estimates.note"), /4/);
    });

    it(`[${lang}] el diálogo de gasto muestra caracteres y tokens estimados`, async () => {
      const t = createTranslator(lang);
      const elements = Object.fromEntries(["spend-confirm-title", "spend-confirm-body", "spend-confirm-yes", "spend-confirm-no"].map((id) => [id, new FakeElement(id)]));
      elements["spend-confirm"] = new FakeDialog("spend-confirm");
      const doc = { documentElement: { lang }, activeElement: null, getElementById: (id) => elements[id] ?? null };
      const spend = createSpendConfirm({ doc, t });
      const answer = spend.ask({ provider: "openai", characters: 800 });
      await Promise.resolve();
      const body = elements["spend-confirm-body"].textContent;
      assert.match(body, /800/);
      assert.match(body, /200/);
      elements["spend-confirm-no"].fire("click");
      await answer;
    });
  }
});
