import { describe, expect, it } from "vitest";

import { contentDisposition, downloadName } from "../src/jobs/jobs.service.js";

describe("downloadName", () => {
  it("usa el nombre del video sin su extensión y añade la del artefacto", () => {
    expect(downloadName("entrevista.mp4", "srt")).toBe("entrevista.srt");
    expect(downloadName("clase 1.final.MKV", "segments")).toBe("clase 1.final.segments.json");
    expect(downloadName("a.mov", "waveform")).toBe("a.waveform.json");
    expect(downloadName("a.mov", "audio", "DUB")).toBe("a.dub.mp3");
    expect(downloadName("a.mov", "video", "DUB")).toBe("a.dubbed.mp4");
    expect(downloadName("a.mov", "video", "BURN")).toBe("a.captioned.mp4");
    expect(downloadName("a.mov", "video")).toBe("a.captioned.mp4");
  });

  it("tiene un nombre de reserva cuando el original no tiene base", () => {
    expect(downloadName(".mp4", "srt")).toBe("captionforge.srt");
  });
});

describe("contentDisposition", () => {
  it("escapa comillas, barras, saltos de línea y no ASCII en la parte simple, y conserva el nombre real en UTF-8", () => {
    const header = contentDisposition('a"b\\c\r\nSet-Cookie: x=1;ñ.srt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="')).toBe(true);
    const simple = /filename="([^"]*)"/.exec(header)![1]!;
    expect(simple).not.toMatch(/["\\\r\n;%]/);
    expect(simple).toMatch(/^[\x20-\x7e]*$/);
    expect(header).toContain("filename*=UTF-8''a%22b%5Cc%0D%0ASet-Cookie%3A%20x%3D1%3B%C3%B1.srt");
  });

  it("deja intactos los nombres normales", () => {
    expect(contentDisposition("entrevista.srt")).toBe("attachment; filename=\"entrevista.srt\"; filename*=UTF-8''entrevista.srt");
  });
});
