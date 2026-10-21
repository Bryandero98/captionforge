import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SegmentsError,
  applyEdits,
  formatTimestamp,
  parseEdits,
  parseSegments,
  redistributeWordTimings,
  segmentsToSrt,
} from "../src/jobs/segments.js";

const goldenPath = fileURLToPath(new URL("../../../packages/contracts/examples/segments-golden.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf-8")) as {
  srt: { name: string; segments: unknown[]; expected: string }[];
  redistribute: { text: string; start: number; end: number; expected: unknown }[];
};

describe("paridad con Python (vectores generados por legacy/src/captionforge/srt.py)", () => {
  it.each(golden.srt.map((c) => [c.name, c] as const))("segmentsToSrt: %s", (_name, c) => {
    expect(segmentsToSrt(parseSegments(c.segments))).toBe(c.expected);
  });

  it.each(golden.redistribute.map((c) => [JSON.stringify(c.text) + ` [${c.start}, ${c.end}]`, c] as const))(
    "redistributeWordTimings: %s",
    (_name, c) => {
      expect(redistributeWordTimings(c.text, c.start, c.end)).toEqual(c.expected);
    },
  );
});

describe("formatTimestamp", () => {
  it("redondea al par como Python (0,5 ms -> 0; 1,5 ms -> 2)", () => {
    expect(formatTimestamp(0.0005)).toBe("00:00:00,000");
    expect(formatTimestamp(0.0015)).toBe("00:00:00,002");
  });
  it("rechaza tiempos negativos", () => {
    expect(() => formatTimestamp(-1)).toThrow(SegmentsError);
  });
});

const base = [
  { start: 0, end: 2, text: "Hola mundo", words: [{ start: 0, end: 1, text: "Hola", probability: 0.9 }, { start: 1, end: 2, text: "mundo", probability: 0.8 }] },
  { start: 2, end: 4, text: "Segunda", words: null },
];

describe("applyEdits", () => {
  it("cambiar solo los tiempos conserva los tiempos por palabra", () => {
    const [first] = applyEdits(parseSegments(base), [{ index: 0, start: 0.5, end: 2.5 }]);
    expect(first).toMatchObject({ start: 0.5, end: 2.5, text: "Hola mundo" });
    expect(first!.words).toEqual(parseSegments(base)[0]!.words);
  });

  it("cambiar el texto reparte de nuevo los tiempos (probability null = sintético)", () => {
    const [first] = applyEdits(parseSegments(base), [{ index: 0, text: "  Adiós a todos " }]);
    expect(first!.text).toBe("Adiós a todos");
    expect(first!.words!.map((w) => w.text)).toEqual(["Adiós", "a", "todos"]);
    expect(first!.words!.every((w) => w.probability === null)).toBe(true);
    expect(first!.words![0]!.start).toBe(0);
    expect(first!.words!.at(-1)!.end).toBe(2);
  });

  it("un texto igual (salvo espacios) no cuenta como cambio", () => {
    const [first] = applyEdits(parseSegments(base), [{ index: 0, text: "  Hola mundo  " }]);
    expect(first!.words).toEqual(parseSegments(base)[0]!.words);
  });

  it("vaciar el texto deja el segmento sin tiempos por palabra", () => {
    expect(applyEdits(parseSegments(base), [{ index: 0, text: "" }])[0]!.words).toBeNull();
  });

  it("no modifica la entrada y deja intactos los demás segmentos", () => {
    const original = parseSegments(base);
    const copy = structuredClone(original);
    const result = applyEdits(original, [{ index: 0, text: "otro" }]);
    expect(original).toEqual(copy);
    expect(result[1]).toBe(original[1]);
  });

  it.each([
    ["índice fuera de rango", [{ index: 5, text: "x" }]],
    ["fin antes del inicio", [{ index: 0, start: 3, end: 1 }]],
    ["inicio negativo", [{ index: 0, start: -1 }]],
    ["duración cero", [{ index: 0, start: 1, end: 1 }]],
  ])("rechaza %s", (_name, edits) => {
    expect(() => applyEdits(parseSegments(base), edits)).toThrow(SegmentsError);
  });
});

describe("parseEdits", () => {
  it("acepta ediciones parciales y un etag opcional", () => {
    const parsed = parseEdits({ segments: [{ index: 1, text: "x" }, { index: 0, start: 1 }], etag: "0".repeat(32) });
    expect(parsed.edits).toHaveLength(2);
    expect(parsed.etag).toBe("0".repeat(32));
  });

  it.each([
    ["no es un objeto", "texto"],
    ["falta segments", {}],
    ["índice no entero", { segments: [{ index: 1.5 }] }],
    ["índice negativo", { segments: [{ index: -1 }] }],
    ["índice repetido", { segments: [{ index: 0 }, { index: 0 }] }],
    ["texto no es cadena", { segments: [{ index: 0, text: 5 }] }],
    ["start no finito", { segments: [{ index: 0, start: "1" }] }],
    ["campo desconocido", { segments: [], extra: 1 }],
    ["etag mal formado", { segments: [], etag: "nope" }],
    ["texto enorme", { segments: [{ index: 0, text: "x".repeat(2001) }] }],
  ])("rechaza: %s", (_name, body) => {
    expect(() => parseEdits(body)).toThrow(SegmentsError);
  });
});

describe("parseSegments", () => {
  it.each([
    ["no es lista", {}],
    ["segmento no objeto", [1]],
    ["falta texto", [{ start: 0, end: 1 }]],
    ["NaN", [{ start: Number.NaN, end: 1, text: "x" }]],
    ["words no lista", [{ start: 0, end: 1, text: "x", words: "a" }]],
    ["palabra inválida", [{ start: 0, end: 1, text: "x", words: [{ start: 0 }] }]],
  ])("rechaza: %s", (_name, raw) => {
    expect(() => parseSegments(raw)).toThrow(SegmentsError);
  });

  it("tolera words ausente o lista vacía (equivale a sin tiempos)", () => {
    expect(parseSegments([{ start: 0, end: 1, text: "x" }, { start: 1, end: 2, text: "y", words: [] }]).map((s) => s.words)).toEqual([null, null]);
  });
});
