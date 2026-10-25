// Formato de las claves (ADR 0022): con URL base propia la clave es de OTRO servicio (Gemini, Groq, Claude...) y no tiene la forma de la de OpenAI.
import { describe, expect, it } from "vitest";

import { normalizeExternalKey } from "../src/external-keys/external-key-format.js";

const FOREIGN = {
  gemini: "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
  groq: "gsk_abcdefghijklmnopqrstuvwxyz0123456789",
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
  openrouter: "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123",
  abacus: "s2_0123456789abcdef0123456789abcdef",
  ollama: "ollama-local-key",
};

describe("clave de OpenAI sin URL base propia (como siempre)", () => {
  it("exige la forma de OpenAI y rechaza la de otros servicios", () => {
    expect(normalizeExternalKey("openai", "sk-proj-abcdefghijklmnopqrstuvwxyz0123")).toBe("sk-proj-abcdefghijklmnopqrstuvwxyz0123");
    for (const key of [FOREIGN.gemini, FOREIGN.groq, FOREIGN.abacus]) expect(normalizeExternalKey("openai", key), key).toBeUndefined();
  });
});

describe("clave con URL base propia (custom)", () => {
  const custom = { custom: true };

  it("acepta la clave de cualquier servicio, con espacios de los extremos recortados", () => {
    for (const [name, key] of Object.entries(FOREIGN)) {
      expect(normalizeExternalKey("openai", key, custom), name).toBe(key);
      expect(normalizeExternalKey("openai", ` \r\n${key}\n `, custom), name).toBe(key);
    }
  });

  it("admite claves cortas (Ollama no valida la clave) pero no menos de 8 caracteres", () => {
    expect(normalizeExternalKey("openai", "12345678", custom)).toBe("12345678");
    expect(normalizeExternalKey("openai", "1234567", custom)).toBeUndefined();
  });

  it("sigue rechazando espacios dentro, no ASCII, vacío, otros tipos y demasiado largo", () => {
    for (const bad of ["clave con espacios dentro", "clavecon\u00f1a-larga-aaaaaaaa", "", "   ", 5, null, undefined, "a".repeat(600)]) {
      expect(normalizeExternalKey("openai", bad, custom), String(bad)).toBeUndefined();
    }
  });

  it("no relaja a ElevenLabs: su clave tiene siempre su forma", () => {
    expect(normalizeExternalKey("elevenlabs", "12345678", custom)).toBeUndefined();
  });
});
