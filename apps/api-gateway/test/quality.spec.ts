import { describe, expect, it } from "vitest";

import type { Segment } from "../src/jobs/segments.js";
import { PROFILES, QUALITY_PROFILE_IDS, getProfile, validateProfile } from "../src/quality/profiles.js";
import { checkQuality } from "../src/quality/verifier.js";

const netflix = getProfile("netflix");
const seg = (start: number, end: number, text: string): Segment => ({ start, end, text, words: null });
const rules = (segments: Segment[], profile = netflix) => checkQuality(segments, profile).issues.map((issue) => `${issue.segment}:${issue.rule}:${issue.severity}`);

describe("perfiles", () => {
  it("incluye netflix, bbc, accessible y shorts, con identificadores únicos", () => {
    expect([...QUALITY_PROFILE_IDS].sort()).toEqual(["accessible", "bbc", "netflix", "shorts"]);
    expect(new Set(PROFILES.map((profile) => profile.id)).size).toBe(PROFILES.length);
  });

  it("todos los perfiles son válidos y citan su fuente", () => {
    for (const profile of PROFILES) {
      expect(() => validateProfile(profile), profile.id).not.toThrow();
      expect(profile.reference.length, profile.id).toBeGreaterThan(10);
    }
  });

  it.each([
    ["límite de caracteres por línea en 0", { maxCharsPerLine: 0 }],
    ["fotogramas por segundo negativos", { fps: -24 }],
    ["duración mínima mayor que la máxima", { minDuration: 9, maxDuration: 2 }],
    ["margen duro de CPS negativo", { cpsErrorMargin: -1 }],
    ["identificador con mayúsculas o espacios", { id: "Mi Perfil" }],
  ])("rechaza un perfil con %s", (_name, change) => {
    expect(() => validateProfile({ ...netflix, ...change })).toThrow();
  });

  it("un perfil desconocido falla con un error claro", () => {
    expect(() => getProfile("inventado")).toThrow(/inventado/);
  });
});

describe("regla cps (caracteres por segundo)", () => {
  it("un subtítulo dentro del límite no genera incidencias", () => {
    expect(rules([seg(0, 2, "Hola, ¿qué tal?")])).toEqual([]);
  });

  it("por encima del límite es un aviso y informa lo medido", () => {
    // 83 caracteres en 4 s = 20,75 cps (límite 20)
    const text = "a".repeat(41) + "\n" + "b".repeat(42);
    const report = checkQuality([seg(0, 4, text)], netflix);
    const cps = report.issues.find((issue) => issue.rule === "cps");
    expect(cps).toMatchObject({ segment: 0, severity: "warning", limit: 20 });
    expect(cps?.measured).toBe(20.8); // 83 caracteres sin el salto / 4 s
  });

  it("muy por encima del límite (margen duro) es un error", () => {
    expect(rules([seg(0, 1, "x".repeat(40))])).toContain("0:cps:error");
  });

  it("no cuenta las etiquetas de formato ni los saltos de línea", () => {
    const text = "<i>" + "a".repeat(30) + "</i>";
    const report = checkQuality([seg(0, 1.5, text)], netflix); // 30 / 1,5 = 20 cps: en el límite, sin incidencia
    expect(report.issues.filter((issue) => issue.rule === "cps")).toEqual([]);
  });

  it("cuenta los caracteres por punto de código (un emoji es uno)", () => {
    const report = checkQuality([seg(0, 1, "😀".repeat(20))], netflix); // 20 / 1 = 20 cps
    expect(report.issues.filter((issue) => issue.rule === "cps")).toEqual([]);
  });
});

describe("regla cpl y lines", () => {
  it("los espacios al principio y al final de la línea no cuentan (Whisper entrega « Hola»)", () => {
    expect(rules([seg(0, 5, " " + "a".repeat(42) + "  ")])).toEqual([]);
  });

  it("una línea más larga que el límite es un error con el número de línea", () => {
    const report = checkQuality([seg(0, 5, "a".repeat(30) + "\n" + "b".repeat(50))], netflix);
    expect(report.issues.find((issue) => issue.rule === "cpl")).toMatchObject({ segment: 0, severity: "error", measured: 50, limit: 42, line: 2 });
  });

  it("tres líneas superan el máximo de dos", () => {
    expect(rules([seg(0, 6, "uno\ndos\ntres")])).toContain("0:lines:error");
  });

  it("el perfil shorts es más estricto con la longitud de línea", () => {
    const shorts = getProfile("shorts");
    expect(rules([seg(0, 3, "a".repeat(30))], shorts)).toContain("0:cpl:error");
    expect(rules([seg(0, 3, "a".repeat(30))], netflix)).not.toContain("0:cpl:error");
  });
});

describe("reglas de duración", () => {
  it("menos de la duración mínima es un aviso", () => {
    expect(rules([seg(0, 0.5, "Sí")])).toContain("0:duration_min:warning");
  });
  it("más de la duración máxima es un aviso", () => {
    expect(rules([seg(0, 8, "Sí")])).toContain("0:duration_max:warning");
  });
});

describe("reglas entre subtítulos", () => {
  it("empezar antes de que acabe el anterior es un error de solape con lo medido en segundos", () => {
    const report = checkQuality([seg(0, 2, "Uno"), seg(1.5, 4, "Dos")], netflix);
    expect(report.issues.find((issue) => issue.rule === "overlap")).toMatchObject({ segment: 1, severity: "error", measured: 0.5 });
  });

  it("una separación menor que la mínima es un aviso", () => {
    // 2 fotogramas a 24 fps = 83 ms; aquí hay 40 ms
    expect(rules([seg(0, 2, "Uno"), seg(2.04, 4, "Dos")])).toContain("1:gap_min:warning");
  });

  it("una separación suficiente no genera incidencias", () => {
    expect(rules([seg(0, 2, "Uno"), seg(2.1, 4.1, "Dos")])).toEqual([]);
  });

  it("subtítulos pegados exactamente (hueco 0) cuentan como separación insuficiente, no como solape", () => {
    const found = rules([seg(0, 2, "Uno"), seg(2, 4, "Dos")]);
    expect(found).toContain("1:gap_min:warning");
    expect(found).not.toContain("1:overlap:error");
  });
});

describe("datos inválidos y equilibrio", () => {
  it("un subtítulo que acaba antes de empezar es un error y no se mide su CPS", () => {
    const found = rules([seg(3, 3, "Hola"), seg(5, 4, "Adiós")]);
    expect(found).toContain("0:invalid_timing:error");
    expect(found).toContain("1:invalid_timing:error");
    expect(found.some((entry) => entry.includes(":cps:"))).toBe(false);
  });

  it("dos líneas muy desiguales dan una nota informativa", () => {
    const text = "a".repeat(40) + "\n" + "b".repeat(8);
    expect(rules([seg(0, 4, text)])).toContain("0:balance:info");
  });
});

describe("resumen", () => {
  it("cuenta errores, avisos e informaciones y calcula la nota", () => {
    const report = checkQuality([seg(0, 2, "Hola"), seg(2.5, 3, "x".repeat(40))], netflix);
    expect(report.profile).toBe("netflix");
    expect(report.summary.segments).toBe(2);
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.summary.score).toBe(50); // 1 de 2 subtítulos sin incidencias de error o aviso
  });

  it("sin subtítulos la nota es 100 y no hay incidencias", () => {
    expect(checkQuality([], netflix)).toMatchObject({ summary: { segments: 0, errors: 0, warnings: 0, infos: 0, score: 100 }, issues: [] });
  });

  it("las incidencias salen ordenadas por subtítulo y gravedad", () => {
    const report = checkQuality([seg(0, 0.4, "x".repeat(60)), seg(0.41, 3, "ok")], netflix);
    const order = report.issues.map((issue) => issue.segment);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
