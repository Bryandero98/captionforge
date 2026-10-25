// Audio o video: lo que la interfaz decide con la clase del archivo (Issue #14, audio universal).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIO_EXTENSIONS, DUB_MIXES_FOR, canBurn, isAudioJob, isAudioMime } from "../public/js/domain/media.js";

describe("isAudioJob", () => {
  it("lo dice el trabajo (`mediaKind`)", () => {
    assert.equal(isAudioJob({ mediaKind: "audio" }), true);
    assert.equal(isAudioJob({ mediaKind: "video" }), false);
  });

  it("sin dato (servidor antiguo, trabajo raro) cuenta como video: nada se oculta por error", () => {
    for (const job of [{}, null, undefined, { mediaKind: "otra-cosa" }, { mediaKind: 7 }, "audio"]) assert.equal(isAudioJob(job), false, JSON.stringify(job));
  });
});

describe("isAudioMime", () => {
  it("reconoce los tipos de MP3, WAV, M4A, OGG y FLAC", () => {
    for (const type of ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/ogg", "audio/flac", "audio/x-flac"]) {
      assert.equal(isAudioMime(type), true, type);
    }
  });

  it("reconoce también los audios ampliados (OPUS, AAC, AMR, WMA, AIFF, WEBA)", () => {
    for (const type of ["audio/opus", "audio/aac", "audio/x-aac", "audio/amr", "audio/x-ms-wma", "audio/aiff", "audio/x-aiff", "audio/webm"]) {
      assert.equal(isAudioMime(type), true, type);
    }
  });

  it("no confunde video ni tipos vacíos", () => {
    for (const type of ["video/mp4", "video/webm", "text/plain", "", undefined, null]) assert.equal(isAudioMime(type), false, String(type));
  });
});

describe("qué se ofrece según la clase", () => {
  it("el quemado de subtítulos solo existe con imagen", () => {
    assert.equal(canBurn({ mediaKind: "video" }), true);
    assert.equal(canBurn({}), true);
    assert.equal(canBurn({ mediaKind: "audio" }), false);
  });

  it("un audio solo se dobla a pista de voz; un video admite las tres salidas", () => {
    assert.deepEqual(DUB_MIXES_FOR({ mediaKind: "audio" }), ["none"]);
    assert.deepEqual(DUB_MIXES_FOR({ mediaKind: "video" }), ["none", "replace", "duck"]);
    assert.deepEqual(DUB_MIXES_FOR(null), ["none", "replace", "duck"]);
  });

  it("las extensiones de audio son las del producto (v1.3.1: con las notas de voz y los formatos de celular)", () => {
    assert.deepEqual([...AUDIO_EXTENSIONS].sort(), ["aac", "aif", "aiff", "amr", "flac", "m4a", "mp3", "ogg", "opus", "wav", "weba", "wma"]);
  });
});
