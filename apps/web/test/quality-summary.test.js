// Frases del editor guiado (ADR 0027): cabecera con plural y insignia de calidad.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RULE_ORDER, badgeText, describeFix, describeIssue, headlineChips } from "../public/js/domain/quality-summary.js";

const t = (key, params = {}) => `${key}|${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")}`;
const issue = (segment, rule, severity = "warning") => ({ segment, rule, severity, measured: 1, limit: 1 });

describe("headlineChips", () => {
  it("una por regla, en singular o plural según la cantidad de subtítulos", () => {
    const chips = headlineChips([issue(1, "cps"), issue(2, "cps"), issue(3, "cps"), issue(4, "overlap", "error")], t);
    assert.deepEqual(chips.map((c) => [c.rule, c.text]), [
      ["overlap", "guided.rule.overlap.one|count=1"],
      ["cps", "guided.rule.cps.other|count=3"],
    ]);
    assert.equal(chips[0].severity, "error");
    assert.deepEqual(chips[1].segments, [1, 2, 3]);
  });
  it("sin incidencias no hay fichas", () => assert.deepEqual(headlineChips([], t), []));
  it("una regla desconocida usa el texto genérico para no quedar muda", () => {
    assert.equal(headlineChips([issue(0, "nueva")], t)[0].text, "guided.rule.other.one|count=1");
  });
  it("hay frase de singular y plural para cada regla conocida", () => {
    assert.deepEqual([...RULE_ORDER].sort(), ["balance", "cpl", "cps", "duration_max", "duration_min", "gap_min", "invalid_timing", "lines", "overlap"]);
  });
});

describe("badgeText", () => {
  it("nota y número de avisos (errores y avisos; las sugerencias no)", () => {
    assert.equal(badgeText({ segments: 10, errors: 1, warnings: 2, infos: 4, score: 92 }, t), "guided.badge|score=92,count=3");
  });
  it("sin avisos dice que no hay nada que revisar", () => {
    assert.equal(badgeText({ segments: 10, errors: 0, warnings: 0, infos: 4, score: 100 }, t), "guided.badge.clean|score=100");
  });
});

describe("describeIssue", () => {
  it("usa la frase de la regla con lo medido, el límite, la línea y el porcentaje", () => {
    const text = describeIssue({ segment: 0, rule: "balance", severity: "info", measured: 0.4, limit: 0.5, line: 2 }, t, (n) => `<${n}>`);
    assert.equal(text, "quality.rule.balance|measured=<0.4>,limit=<0.5>,line=2,percent=40");
  });
  it("sin línea usa la 1", () => {
    assert.match(describeIssue({ segment: 0, rule: "cpl", severity: "warning", measured: 50, limit: 42 }, t, String), /line=1/);
  });
});

describe("describeFix", () => {
  const n = (value) => `<${value}>`;
  it("describe cada campo que cambia: saltos de línea, inicio y final, en ese orden", () => {
    assert.deepEqual(describeFix({ segment: 0, rules: [], kinds: [], edit: { end: 3.25, text: "a\nb", start: 1 } }, t, n), [
      "guided.fix.line_break|",
      "guided.fix.start|time=<1>",
      "guided.fix.end|time=<3.25>",
    ]);
  });
  it("una edición vacía no describe nada", () => assert.deepEqual(describeFix({ segment: 0, rules: [], kinds: [], edit: {} }, t, n), []));
});
