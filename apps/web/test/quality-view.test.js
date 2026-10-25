// Vista del editor guiado (ADR 0027): agrupar incidencias, navegar entre subtítulos afectados y dibujar el minimapa lógico.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fixesBySegment, groupByRule, issuesBySegment, minimapBlocks, stepSegment, worstSeverity } from "../public/js/domain/quality-view.js";

const issue = (segment, rule, severity = "warning") => ({ segment, rule, severity, measured: 1, limit: 1 });
const ISSUES = [issue(4, "cps"), issue(1, "cps"), issue(2, "overlap", "error"), issue(4, "cpl"), issue(7, "balance", "info")];

describe("groupByRule", () => {
  it("agrupa por regla con la mayor gravedad, los subtítulos sin repetir y ordena por gravedad y luego por cantidad", () => {
    assert.deepEqual(groupByRule(ISSUES), [
      { rule: "overlap", severity: "error", count: 1, segments: [2] },
      { rule: "cps", severity: "warning", count: 2, segments: [1, 4] },
      { rule: "cpl", severity: "warning", count: 1, segments: [4] },
      { rule: "balance", severity: "info", count: 1, segments: [7] },
    ]);
  });
  it("sin incidencias no hay grupos", () => assert.deepEqual(groupByRule([]), []));
  it("una misma regla dos veces en un subtítulo cuenta una vez", () => {
    assert.equal(groupByRule([issue(3, "cpl"), issue(3, "cpl")])[0].count, 1);
  });
});

describe("por subtítulo", () => {
  it("issuesBySegment ordena las incidencias de cada subtítulo de más a menos grave", () => {
    const map = issuesBySegment([issue(4, "cps"), issue(4, "overlap", "error"), issue(4, "balance", "info")]);
    assert.deepEqual(map.get(4).map((i) => i.rule), ["overlap", "cps", "balance"]);
  });
  it("worstSeverity da la peor o null", () => {
    assert.equal(worstSeverity([issue(0, "a", "info"), issue(0, "b", "error")]), "error");
    assert.equal(worstSeverity([]), null);
  });
  it("fixesBySegment indexa los arreglos por subtítulo", () => {
    const map = fixesBySegment([{ segment: 5, rules: [], kinds: [], edit: {} }]);
    assert.equal(map.get(5).segment, 5);
    assert.equal(map.get(6), undefined);
  });
});

describe("stepSegment", () => {
  const segments = [1, 4, 9];
  it("avanza y retrocede dando la vuelta", () => {
    assert.equal(stepSegment(segments, 1, 1), 4);
    assert.equal(stepSegment(segments, 9, 1), 1);
    assert.equal(stepSegment(segments, 1, -1), 9);
  });
  it("desde un subtítulo sin incidencia salta al siguiente o anterior más cercano", () => {
    assert.equal(stepSegment(segments, 5, 1), 9);
    assert.equal(stepSegment(segments, 5, -1), 4);
    assert.equal(stepSegment(segments, null, 1), 1);
    assert.equal(stepSegment(segments, null, -1), 9);
  });
  it("sin subtítulos afectados devuelve null", () => assert.equal(stepSegment([], 3, 1), null));
});

describe("minimapBlocks", () => {
  const segs = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 10 }));
  it("sin incidencias no hay marcas", () => {
    assert.deepEqual(minimapBlocks({ segments: segs, issues: [], widthPx: 480 }), []);
  });
  it("una marca por tramo con la peor gravedad, el primer subtítulo y el recuento", () => {
    const blocks = minimapBlocks({ segments: segs, issues: [issue(0, "cps"), issue(1, "overlap", "error"), issue(9, "balance", "info")], widthPx: 96 });
    assert.equal(blocks.length, 2);
    assert.deepEqual({ severity: blocks[0].severity, first: blocks[0].first, count: blocks[0].count, segments: blocks[0].segments }, { severity: "error", first: 0, count: 2, segments: [0, 1] });
    assert.equal(blocks[1].severity, "info");
    assert.ok(blocks[1].leftPct > blocks[0].leftPct);
  });
  it("cada marca mide al menos 24 px de ancho útil: en una franja estrecha se fusionan más", () => {
    const wide = minimapBlocks({ segments: segs, issues: segs.map((_, i) => issue(i, "cps")), widthPx: 480 });
    const narrow = minimapBlocks({ segments: segs, issues: segs.map((_, i) => issue(i, "cps")), widthPx: 96 });
    assert.ok(narrow.length < wide.length);
    for (const block of narrow) assert.ok((block.widthPct / 100) * 96 >= 24 - 1e-9);
  });
  it("los porcentajes quedan dentro de 0 a 100", () => {
    for (const block of minimapBlocks({ segments: segs, issues: segs.map((_, i) => issue(i, "cps")), widthPx: 300 })) {
      assert.ok(block.leftPct >= 0 && block.leftPct + block.widthPct <= 100 + 1e-9);
    }
  });
  it("tolera lista vacía, duración cero y tiempos raros sin lanzar", () => {
    assert.deepEqual(minimapBlocks({ segments: [], issues: [issue(0, "cps")], widthPx: 300 }), []);
    assert.deepEqual(minimapBlocks({ segments: [{ start: 0, end: 0 }], issues: [issue(0, "cps")], widthPx: 300 }).length, 1);
    assert.deepEqual(minimapBlocks({ segments: segs, issues: [issue(99, "cps")], widthPx: 300 }), []);
    assert.equal(minimapBlocks({ segments: segs, issues: [issue(0, "cps")], widthPx: 0 }).length, 1);
  });
});
