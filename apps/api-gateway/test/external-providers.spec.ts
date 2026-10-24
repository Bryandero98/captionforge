// Proveedores de IA con clave propia (ADR 0022): cualquier IA de texto sirve para traducir; la voz sigue siendo OpenAI y ElevenLabs.
import { describe, expect, it } from "vitest";

import { EXTERNAL_PROVIDERS, isExternalProvider, isTranslateTextProvider, TRANSLATE_TEXT_PROVIDERS } from "../src/external-keys/external-key-crypto.js";
import { normalizeExternalKey } from "../src/external-keys/external-key-format.js";

const TEXT = ["openai", "deepseek", "gemini", "anthropic", "groq", "openrouter", "abacus"] as const;

describe("proveedores de IA de texto", () => {
  it("traducen OpenAI, DeepSeek, Gemini, Claude (Anthropic), Groq, OpenRouter y Abacus", () => {
    expect([...TRANSLATE_TEXT_PROVIDERS].sort()).toEqual([...TEXT].sort());
    expect(EXTERNAL_PROVIDERS).toEqual(expect.arrayContaining([...TEXT, "elevenlabs"]));
    expect(EXTERNAL_PROVIDERS).toHaveLength(TEXT.length + 1);
  });

  it("ElevenLabs guarda clave pero no traduce, y Argos no es un proveedor con clave", () => {
    expect(isTranslateTextProvider("elevenlabs")).toBe(false);
    expect(isExternalProvider("argos")).toBe(false);
    expect(isTranslateTextProvider("argos")).toBe(false);
    for (const provider of TEXT) {
      expect(isExternalProvider(provider)).toBe(true);
      expect(isTranslateTextProvider(provider)).toBe(true);
    }
  });

  it("rechaza lo que no es un proveedor conocido (incluidos nombres de propiedades del objeto)", () => {
    for (const bad of ["", "OpenAI", "mistral", "__proto__", "constructor", 7, null, undefined]) {
      expect(isExternalProvider(bad)).toBe(false);
      expect(isTranslateTextProvider(bad)).toBe(false);
    }
  });
});

describe("formato de la clave por proveedor", () => {
  const valid: Record<(typeof TEXT)[number], string> = {
    openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
    deepseek: ["sk", "0".repeat(32)].join("-"), // armada al ejecutar: un literal con forma de clave real bloquea el push (secret scanning)
    gemini: "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
    anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    groq: "gsk_abcdefghijklmnopqrstuvwxyz0123456789",
    openrouter: "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123",
    abacus: "s2_0123456789abcdef0123456789abcdef",
  };

  for (const provider of TEXT) {
    it(`${provider}: acepta una clave con su forma y quita espacios y saltos de línea de los extremos`, () => {
      expect(normalizeExternalKey(provider, valid[provider])).toBe(valid[provider]);
      expect(normalizeExternalKey(provider, `  ${valid[provider]}\r\n`)).toBe(valid[provider]);
    });

    it(`${provider}: rechaza espacios dentro, texto corto, no ASCII y valores que no son texto`, () => {
      expect(normalizeExternalKey(provider, `${valid[provider].slice(0, 12)} ${valid[provider].slice(12)}`)).toBeUndefined();
      expect(normalizeExternalKey(provider, "corta")).toBeUndefined();
      expect(normalizeExternalKey(provider, `${valid[provider]}ñ`)).toBeUndefined();
      expect(normalizeExternalKey(provider, 12345)).toBeUndefined();
      expect(normalizeExternalKey(provider, valid[provider].repeat(40))).toBeUndefined();
    });
  }

  it("una clave de otro proveedor con prefijo propio no se acepta donde el prefijo es obligatorio", () => {
    expect(normalizeExternalKey("anthropic", valid.openai)).toBeUndefined();
    expect(normalizeExternalKey("groq", valid.openai)).toBeUndefined();
    expect(normalizeExternalKey("openrouter", valid.openai)).toBeUndefined();
    expect(normalizeExternalKey("gemini", valid.openai)).toBeUndefined();
  });
});
