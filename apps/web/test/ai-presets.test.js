// Servicios de IA compatibles con OpenAI que el panel ofrece en un menú (ADR 0022): rellenan la URL base y sugieren modelos.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AI_PRESETS, findPreset, presetForHost, presetForUrl, visiblePresets } from "../public/js/domain/ai-presets.js";

const ids = (list) => list.map((preset) => preset.id);

describe("catálogo de servicios", () => {
  it("incluye OpenAI, DeepSeek, Gemini, Claude (Anthropic), Groq, OpenRouter, Abacus, Ollama y «otro»", () => {
    assert.deepEqual(ids(AI_PRESETS), ["openai", "deepseek", "gemini", "anthropic", "groq", "openrouter", "abacus", "ollama", "custom"]);
  });

  it("OpenAI y «otro» no fijan URL; los demás sí, y todas las públicas son https sin barra final", () => {
    assert.equal(findPreset("openai").baseUrl, "");
    assert.equal(findPreset("custom").baseUrl, "");
    for (const preset of AI_PRESETS.filter((p) => !["openai", "custom"].includes(p.id))) {
      assert.match(preset.baseUrl, preset.local ? /^http:\/\/localhost:\d+\/v1$/ : /^https:\/\/[a-z0-9.-]+(\/[a-z0-9/._-]+)?$/, preset.id);
      assert.equal(preset.baseUrl.endsWith("/"), false, preset.id);
    }
  });

  it("cada servicio con URL sugiere al menos un modelo con formato válido para el API", () => {
    const valid = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
    for (const preset of AI_PRESETS.filter((p) => p.id !== "custom")) {
      assert.ok(preset.models.length > 0, preset.id);
      for (const model of preset.models) assert.match(model, valid, `${preset.id}: ${model}`);
      assert.equal(new Set(preset.models).size, preset.models.length, `${preset.id}: modelos repetidos`);
    }
    assert.deepEqual(findPreset("custom").models, []);
  });

  it("DeepSeek, Gemini, Groq y Claude traen sus modelos conocidos", () => {
    assert.ok(findPreset("deepseek").models.includes("deepseek-chat"));
    assert.ok(findPreset("gemini").models.some((m) => m.startsWith("gemini-")));
    assert.ok(findPreset("groq").models.some((m) => m.startsWith("llama")));
    assert.ok(findPreset("anthropic").models.some((m) => m.startsWith("claude-")));
  });

  it("solo Ollama es local", () => {
    assert.deepEqual(AI_PRESETS.filter((preset) => preset.local).map((preset) => preset.id), ["ollama"]);
  });

  it("findPreset devuelve undefined si no existe", () => {
    assert.equal(findPreset("mistral"), undefined);
    assert.equal(findPreset(undefined), undefined);
  });
});

describe("visiblePresets", () => {
  it("sin permiso para servidores locales oculta Ollama", () => {
    assert.equal(ids(visiblePresets({ allowPrivate: false })).includes("ollama"), false);
    assert.equal(ids(visiblePresets({ allowPrivate: false })).length, AI_PRESETS.length - 1);
  });

  it("con permiso lo muestra, y «otro» siempre va al final", () => {
    const list = ids(visiblePresets({ allowPrivate: true }));
    assert.ok(list.includes("ollama"));
    assert.equal(list.at(-1), "custom");
    assert.equal(list[0], "openai");
  });
});

describe("reconocer el servicio por su host o su URL", () => {
  it("el host guardado identifica el servicio", () => {
    assert.equal(presetForHost("api.deepseek.com"), "deepseek");
    assert.equal(presetForHost("generativelanguage.googleapis.com"), "gemini");
    assert.equal(presetForHost("api.groq.com"), "groq");
    assert.equal(presetForHost("localhost:11434"), "ollama");
  });

  it("un host que no está en el catálogo es «otro»; sin host es OpenAI", () => {
    assert.equal(presetForHost("llm.mi-empresa.com"), "custom");
    assert.equal(presetForHost(null), "openai");
    assert.equal(presetForHost(undefined), "openai");
    assert.equal(presetForHost(""), "openai");
  });

  it("la URL escrita a mano también se reconoce, con o sin barra final y en cualquier mayúscula", () => {
    assert.equal(presetForUrl("https://api.deepseek.com/v1"), "deepseek");
    assert.equal(presetForUrl("  HTTPS://API.DEEPSEEK.COM/v1/ "), "deepseek");
    assert.equal(presetForUrl("https://otro.example.com/v1"), "custom");
    assert.equal(presetForUrl(""), "openai");
    assert.equal(presetForUrl("   "), "openai");
  });
});
