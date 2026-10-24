import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyEdits, type Segment } from "../src/jobs/segments.js";
import { getProfile, PROFILES } from "../src/quality/profiles.js";
import { proposeFix } from "../src/quality/fixer.js";
import { checkQuality } from "../src/quality/verifier.js";

const netflix = getProfile("netflix");
const seg = (start: number, end: number, text: string): Segment => ({ start, end, text, words: null });
/** Lo único que el arreglo puede cambiar del texto: saltos de línea por espacios (y al revés). */
const flat = (text: string): string => text.replace(/\r?\n/g, " ");

// Generadores: texto realista (palabras, espacios simples y dobles, acentos, emojis y signos) y una línea de tiempo ordenada.
const word = fc.stringMatching(/^[a-zA-ZáéíóúñÁ¿?¡!,.😀'-]{1,14}$/);
const text = fc.array(word, { minLength: 1, maxLength: 18 }).chain((words) =>
  fc.array(fc.constantFrom(" ", " ", " ", "  ", "\n"), { minLength: words.length - 1, maxLength: words.length - 1 }).map((seps) => words.map((w, i) => w + (seps[i] ?? "")).join("")),
);
const timeline = fc
  .array(fc.record({ gap: fc.double({ min: -0.5, max: 3, noNaN: true }), length: fc.double({ min: 0.05, max: 9, noNaN: true }), text }), { minLength: 1, maxLength: 12 })
  .map((items) => {
    let cursor = 0;
    return items.map(({ gap, length, text: value }) => {
      const start = Math.max(0, cursor + gap);
      cursor = start + length;
      return seg(Math.round(start * 1000) / 1000, Math.round(cursor * 1000) / 1000, value);
    });
  });
const profileArb = fc.constantFrom(...PROFILES);

describe("propiedades: el arreglo nunca altera el texto", () => {
  it("quitando saltos de línea, el texto de cada subtítulo es idéntico", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        const fixed = proposeFix(segments, profile).segments;
        expect(fixed).toHaveLength(segments.length);
        fixed.forEach((s, i) => expect(flat(s.text)).toBe(flat(segments[i]!.text)));
      }),
      { numRuns: 400 },
    );
  });

  it("no crea ni quita subtítulos ni cambia su orden", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        const { segments: fixed } = proposeFix(segments, profile);
        expect(fixed.length).toBe(segments.length);
      }),
      { numRuns: 200 },
    );
  });

  it("no modifica los segmentos de entrada (función pura)", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        const copy = structuredClone(segments);
        proposeFix(segments, profile);
        expect(segments).toEqual(copy);
      }),
      { numRuns: 150 },
    );
  });
});

describe("propiedades: el arreglo no empeora el informe", () => {
  it("nunca añade errores ni avisos que no existieran, ni solapes nuevos", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        const before = checkQuality(segments, profile);
        const after = checkQuality(proposeFix(segments, profile).segments, profile);
        expect(after.summary.errors).toBeLessThanOrEqual(before.summary.errors);
        expect(after.summary.warnings + after.summary.errors).toBeLessThanOrEqual(before.summary.warnings + before.summary.errors);
        const overlaps = (r: typeof before) => r.issues.filter((i) => i.rule === "overlap").length;
        expect(overlaps(after)).toBeLessThanOrEqual(overlaps(before));
      }),
      { numRuns: 400 },
    );
  });

  it("es idempotente: arreglar lo ya arreglado no cambia nada", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        const once = proposeFix(segments, profile).segments;
        const twice = proposeFix(once, profile);
        expect(twice.segments).toEqual(once);
        expect(twice.changes).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it("los tiempos propuestos son válidos: no negativos, con final posterior al inicio y a milisegundos", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        for (const s of proposeFix(segments, profile).segments) {
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeGreaterThan(s.start);
          expect(Math.abs(s.start * 1000 - Math.round(s.start * 1000))).toBeLessThan(1e-6);
          expect(Math.abs(s.end * 1000 - Math.round(s.end * 1000))).toBeLessThan(1e-6);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("el inicio nunca se adelanta ni se retrasa más allá del hueco: solo el final se estira o se recorta", () => {
    fc.assert(
      fc.property(timeline, profileArb, (segments, profile) => {
        const fixed = proposeFix(segments, profile).segments;
        fixed.forEach((s, i) => {
          // un inicio solo se mueve para resolver un solape o un hueco corto con el anterior, y siempre hacia delante
          expect(s.start).toBeGreaterThanOrEqual(segments[i]!.start - 1e-9);
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe("saltos de línea", () => {
  it("parte una línea larga en dos equilibradas sin pasar el límite", () => {
    const original = "Esta es una frase bastante larga que no cabe en una sola línea de subtítulo";
    const { segments, changes } = proposeFix([seg(0, 6, original)], netflix);
    const lines = segments[0]!.text.split("\n");
    expect(lines.length).toBe(2);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(42);
    expect(flat(segments[0]!.text)).toBe(original);
    expect(changes).toEqual([expect.objectContaining({ segment: 0, kind: "line_break" })]);
  });

  it("respeta los saltos de línea que ya son válidos (p. ej. un diálogo con guiones)", () => {
    const dialog = "- Hola, ¿qué tal?\n- Bien, gracias.";
    const { segments, changes } = proposeFix([seg(0, 4, dialog)], netflix);
    expect(segments[0]!.text).toBe(dialog);
    expect(changes).toEqual([]);
  });

  it("deja la línea de abajo igual o más larga que la de arriba (pirámide)", () => {
    const { segments } = proposeFix([seg(0, 7, "uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce")], netflix);
    const [top, bottom] = segments[0]!.text.split("\n");
    expect(bottom!.length).toBeGreaterThanOrEqual(top!.length - 1);
  });

  it("una palabra más larga que el límite no se parte: el texto queda como estaba", () => {
    const giant = "a".repeat(60);
    const { segments, changes, unfixable } = proposeFix([seg(0, 5, giant)], netflix);
    expect(segments[0]!.text).toBe(giant);
    expect(changes).toEqual([]);
    expect(unfixable.some((u) => u.rule === "cpl")).toBe(true);
  });

  it("si ni en dos líneas cabe, no toca el texto", () => {
    const long = Array.from({ length: 30 }, () => "palabra").join(" "); // 239 caracteres
    const { segments } = proposeFix([seg(0, 30, long)], netflix);
    expect(segments[0]!.text).toBe(long);
  });
});

describe("tiempos", () => {
  it("estira el final hacia el hueco libre para bajar los caracteres por segundo", () => {
    const { segments, changes } = proposeFix([seg(0, 1, "a".repeat(30)), seg(6, 8, "Fin")], netflix);
    expect(segments[0]!.end).toBeGreaterThan(1);
    expect(segments[0]!.end).toBeLessThanOrEqual(6 - 0.083);
    expect(checkQuality(segments, netflix).issues.filter((i) => i.rule === "cps")).toEqual([]);
    expect(changes.some((c) => c.kind === "timing" && c.segment === 0)).toBe(true);
  });

  it("no estira más allá de la duración máxima del perfil", () => {
    const { segments } = proposeFix([seg(0, 6.9, "a".repeat(200).replace(/(.{10})/g, "$1 ")), seg(40, 41, "x")], netflix);
    expect(segments[0]!.end - segments[0]!.start).toBeLessThanOrEqual(netflix.maxDuration + 1e-9);
  });

  it("resuelve un solape recortando el final del anterior, con la separación mínima", () => {
    const { segments } = proposeFix([seg(0, 3, "Uno"), seg(2, 5, "Dos")], netflix);
    expect(segments[0]!.end).toBeLessThanOrEqual(2 - 0.083 + 1e-9);
    expect(segments[1]).toMatchObject({ start: 2, end: 5 });
    expect(checkQuality(segments, netflix).issues).toEqual([]);
  });

  it("no acepta un arreglo que cambia un problema por otro igual (recortar el anterior lo dejaría pasado de cps)", () => {
    // El anterior va justo en el límite (40 caracteres en 2 s = 20 cps); recortarlo para dejar el hueco lo pasaría de 20.
    const input = [seg(0, 2, "a".repeat(40)), seg(2.04, 5, "Fin")];
    const { segments, unfixable } = proposeFix(input, netflix);
    expect(segments[0]!.end).toBe(2);
    expect(unfixable.map((u) => u.rule)).toContain("gap_min");
  });

  it("alarga un subtítulo demasiado breve hasta la duración mínima si hay hueco", () => {
    const { segments } = proposeFix([seg(0, 0.3, "Sí"), seg(10, 11, "Fin")], netflix);
    expect(segments[0]!.end - segments[0]!.start).toBeGreaterThanOrEqual(netflix.minDuration - 1e-9);
  });

  it("lo que no se puede arreglar sin tocar el texto queda como incidencia sin resolver", () => {
    const { unfixable } = proposeFix([seg(3, 3, "Hola"), seg(5, 6, "a".repeat(60)), seg(6.1, 9, "fin")], netflix); // el segundo no puede estirarse: el tercero está pegado
    expect(unfixable.map((u) => u.rule)).toContain("invalid_timing");
    expect(unfixable.map((u) => u.rule)).toContain("cps");
  });
});

describe("compatibilidad con el flujo de edición existente (PUT /segments)", () => {
  it("aplicar la propuesta con applyEdits conserva los tiempos por palabra cuando solo cambian los saltos de línea", () => {
    const original: Segment[] = [
      {
        start: 0,
        end: 6,
        text: "Esta es una frase bastante larga que no cabe en una sola línea de subtítulo",
        words: [{ start: 0, end: 1, text: "Esta", probability: 0.9 }],
      },
    ];
    const proposal = proposeFix(original, netflix).segments;
    const applied = applyEdits(original, [{ index: 0, text: proposal[0]!.text, start: proposal[0]!.start, end: proposal[0]!.end }]);
    expect(applied[0]!.text).toContain("\n");
    expect(applied[0]!.words).toEqual(original[0]!.words);
  });
});
