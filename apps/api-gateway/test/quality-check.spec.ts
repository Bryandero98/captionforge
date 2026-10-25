// Medición sin estado de subtítulos NO guardados (editor guiado, ADR 0027): mide lo que manda el cliente, no lo guardado.
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { JobsService } from "../src/jobs/jobs.service.js";
import { QualityService } from "../src/quality/quality.service.js";

const LONG = "Esta es una frase bastante larga que no cabe en una sola línea de subtítulo";

function build() {
  const requireTranscription = vi.fn(async () => undefined);
  const getSegments = vi.fn();
  const service = new QualityService({ requireTranscription, getSegments } as unknown as JobsService);
  return { service, requireTranscription, getSegments };
}

describe("QualityService.check", () => {
  it("mide los subtítulos enviados sin leer los guardados y comprueba que el trabajo es del tenant", async () => {
    const { service, requireTranscription, getSegments } = build();
    const report = await service.check("tenant-1", "job-1", { profile: "netflix", segments: [{ start: 0, end: 6, text: LONG }, { start: 5, end: 8, text: "Hola" }] });
    expect(requireTranscription).toHaveBeenCalledWith("tenant-1", "job-1");
    expect(getSegments).not.toHaveBeenCalled();
    expect(report.profile).toBe("netflix");
    expect(report.summary.segments).toBe(2);
    expect(report.issues.map((issue) => issue.rule)).toEqual(expect.arrayContaining(["cpl", "overlap"]));
  });

  it("propone un arreglo por subtítulo con la edición lista para aplicar en el cliente", async () => {
    const { service } = build();
    const report = await service.check("t", "j", { profile: "netflix", segments: [{ start: 0, end: 6, text: LONG }] });
    expect(report.fixes).toHaveLength(1);
    expect(report.fixes[0]).toMatchObject({ segment: 0, kinds: ["line_break"], rules: expect.arrayContaining(["cpl"]) });
    expect(report.fixes[0]!.edit.text).toContain("\n");
    expect(report.fixes[0]!.edit.start).toBeUndefined();
  });

  it("un subtítulo sin problemas no trae arreglo", async () => {
    const { service } = build();
    const report = await service.check("t", "j", { profile: "netflix", segments: [{ start: 0, end: 2, text: "Hola, ¿qué tal?" }] });
    expect(report.issues).toEqual([]);
    expect(report.fixes).toEqual([]);
    expect(report.summary.score).toBe(100);
  });

  it("un perfil desconocido o ausente es 400 antes de tocar el trabajo", async () => {
    const { service, requireTranscription } = build();
    await expect(service.check("t", "j", { profile: "inventado", segments: [] })).rejects.toThrow(BadRequestException);
    await expect(service.check("t", "j", { segments: [] })).rejects.toThrow(BadRequestException);
    expect(requireTranscription).not.toHaveBeenCalled();
  });

  it.each([
    ["sin cuerpo", undefined],
    ["cuerpo no objeto", "hola"],
    ["segments no es lista", { profile: "netflix", segments: {} }],
    ["segmento no objeto", { profile: "netflix", segments: [3] }],
    ["start no numérico", { profile: "netflix", segments: [{ start: "0", end: 1, text: "a" }] }],
    ["end infinito", { profile: "netflix", segments: [{ start: 0, end: Number.POSITIVE_INFINITY, text: "a" }] }],
    ["start negativo", { profile: "netflix", segments: [{ start: -1, end: 1, text: "a" }] }],
    ["tiempo absurdo", { profile: "netflix", segments: [{ start: 0, end: 2_000_000, text: "a" }] }],
    ["texto no es cadena", { profile: "netflix", segments: [{ start: 0, end: 1, text: 5 }] }],
    ["texto demasiado largo", { profile: "netflix", segments: [{ start: 0, end: 1, text: "x".repeat(2001) }] }],
  ])("rechaza con 400: %s", async (_name, body) => {
    const { service } = build();
    await expect(service.check("t", "j", body)).rejects.toThrow(BadRequestException);
  });

  it("rechaza listas con demasiados subtítulos", async () => {
    const { service } = build();
    const segments = Array.from({ length: 20_001 }, () => ({ start: 0, end: 1, text: "a" }));
    await expect(service.check("t", "j", { profile: "netflix", segments })).rejects.toThrow(BadRequestException);
  });

  it("acepta una lista vacía (informe en cero)", async () => {
    const { service } = build();
    const report = await service.check("t", "j", { profile: "netflix", segments: [] });
    expect(report.summary.segments).toBe(0);
    expect(report.fixes).toEqual([]);
  });
});
