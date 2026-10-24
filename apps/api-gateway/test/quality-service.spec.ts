import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { JobsService } from "../src/jobs/jobs.service.js";
import type { Segment } from "../src/jobs/segments.js";
import { QualityService } from "../src/quality/quality.service.js";

const segments: (Segment & { index: number })[] = [
  { index: 0, start: 0, end: 2, text: "Hola, ¿qué tal?", words: null },
  { index: 1, start: 2.5, end: 3, text: "x".repeat(40), words: null },
];

function build() {
  const getSegments = vi.fn(async () => ({ segments, etag: "abc" }));
  const service = new QualityService({ getSegments } as unknown as JobsService);
  return { service, getSegments };
}

describe("QualityService", () => {
  it("mide los subtítulos del trabajo del tenant con el perfil pedido y devuelve el etag", async () => {
    const { service, getSegments } = build();
    const report = await service.report("tenant-1", "job-1", "bbc");
    expect(getSegments).toHaveBeenCalledWith("tenant-1", "job-1");
    expect(report).toMatchObject({ profile: "bbc", etag: "abc", summary: { segments: 2 } });
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("sin perfil usa netflix", async () => {
    const { service } = build();
    expect((await service.report("t", "j", undefined)).profile).toBe("netflix");
  });

  it("un perfil desconocido es un 400 que lista los disponibles y no lee los subtítulos", async () => {
    const { service, getSegments } = build();
    await expect(service.report("t", "j", "inventado")).rejects.toThrow(BadRequestException);
    await expect(service.report("t", "j", "inventado")).rejects.toThrow(/netflix.*bbc.*accessible.*shorts|accessible.*bbc.*netflix.*shorts|accessible.*bbc.*netflix.*netflix-es.*shorts/s);
    expect(getSegments).not.toHaveBeenCalled();
  });

  it.each(["", " netflix", "NETFLIX", "netflix;drop", "../etc"])("rechaza el perfil mal formado %j", async (value) => {
    const { service } = build();
    await expect(service.report("t", "j", value)).rejects.toThrow(BadRequestException);
  });

  it("lista los perfiles con sus umbrales para que la interfaz los muestre", () => {
    const { service } = build();
    const listed = service.profiles();
    expect(listed.map((profile) => profile.id).sort()).toEqual(["accessible", "bbc", "netflix", "netflix-es", "shorts"]);
    expect(listed[0]).toHaveProperty("maxCharsPerLine");
    expect(listed[0]).toHaveProperty("reference");
  });
});
