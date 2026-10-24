// Las cifras de idiomas del README no deben quedar viejas: salen de la misma lista que usa la interfaz (generada desde faster-whisper).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LANGUAGES } = await import(new URL("../apps/web/public/js/domain/languages.js", import.meta.url));
const read = (name) => readFileSync(join(root, name), "utf8");

describe("README: idiomas compatibles", () => {
  it("la cifra de transcripción coincide con la lista de la interfaz", () => {
    assert.ok(read("README.md").includes(`Transcription (faster-whisper / Whisper): ${LANGUAGES.length} languages`));
    assert.ok(read("README.es.md").includes(`Transcripción (faster-whisper / Whisper): ${LANGUAGES.length} idiomas`));
  });

  it("menciona Argos Translate, el paso por inglés y la descarga bajo demanda en los dos idiomas", () => {
    assert.match(read("README.md"), /through English/);
    assert.match(read("README.md"), /downloaded the first time/);
    assert.match(read("README.es.md"), /pasando por el inglés/);
    assert.match(read("README.es.md"), /descarga la primera vez/);
  });

  it("explica cómo cambiar el puerto en los dos idiomas", () => {
    assert.match(read("README.md"), /CF_PORT=3100/);
    assert.match(read("README.es.md"), /CF_PORT=3100/);
  });
});
