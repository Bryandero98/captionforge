// Tipos de archivo que acepta el servidor (Issue #14, audio): video como siempre y audio puro (MP3, WAV, M4A, OGG, FLAC).
import { describe, expect, it } from "vitest";

import { ALLOWED_CONTENT_TYPES, AUDIO_CONTENT_TYPES, mediaKindOf } from "../src/jobs/media-kind.js";

describe("tipos admitidos", () => {
  it("siguen admitidos los cinco de video", () => {
    for (const type of ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm", "video/x-msvideo"]) {
      expect(ALLOWED_CONTENT_TYPES, type).toContain(type);
    }
  });

  it("se admiten MP3, WAV, M4A, OGG y FLAC con los nombres que mandan los navegadores", () => {
    for (const type of ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/ogg", "audio/flac", "audio/x-flac"]) {
      expect(ALLOWED_CONTENT_TYPES, type).toContain(type);
      expect(AUDIO_CONTENT_TYPES, type).toContain(type);
    }
  });

  it("no se admite lo que no es ninguno de los dos (ni un audio exótico, ni texto ni ejecutables)", () => {
    for (const type of ["audio/aac", "audio/webm", "text/plain", "application/octet-stream", "application/x-msdownload", "image/png", ""]) {
      expect(ALLOWED_CONTENT_TYPES as readonly string[], type).not.toContain(type);
    }
  });

  it("la lista de audio no se cuela entre las de video", () => {
    expect(AUDIO_CONTENT_TYPES.every((type) => type.startsWith("audio/"))).toBe(true);
    expect(new Set(ALLOWED_CONTENT_TYPES).size).toBe(ALLOWED_CONTENT_TYPES.length);
  });
});

describe("mediaKindOf", () => {
  it("clasifica por el tipo guardado", () => {
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("audio/x-m4a")).toBe("audio");
    expect(mediaKindOf("video/mp4")).toBe("video");
    expect(mediaKindOf("video/webm")).toBe("video");
  });

  it("lo desconocido o ausente cuenta como video (los trabajos antiguos no tienen otra cosa)", () => {
    expect(mediaKindOf(null)).toBe("video");
    expect(mediaKindOf(undefined)).toBe("video");
    expect(mediaKindOf("")).toBe("video");
    expect(mediaKindOf("application/octet-stream")).toBe("video");
  });
});
