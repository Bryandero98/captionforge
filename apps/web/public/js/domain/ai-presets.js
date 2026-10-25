// Servicios de IA compatibles con OpenAI que el panel «Claves externas» ofrece en un menú (ADR 0022).
// Elegir uno rellena la URL base y sugiere modelos; el servidor sigue validando todo lo que se envía.

/**
 * @typedef {object} AiPreset
 * @property {string} id
 * @property {string} [name]  Nombre de marca, igual en todos los idiomas; sin él se traduce («otro»).
 * @property {string} baseUrl  Vacía = la de OpenAI (o la que escriba el usuario en «otro»).
 * @property {readonly string[]} models  Sugerencias; el campo de modelo admite cualquier otro nombre.
 * @property {boolean} [local]  Servidor en el propio equipo: solo si el despliegue lo permite (ALLOW_PRIVATE_BASE_URLS).
 */

/** @type {readonly AiPreset[]} */
export const AI_PRESETS = Object.freeze([
  { id: "openai", name: "OpenAI", baseUrl: "", models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"] },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"] },
  { id: "anthropic", name: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"] },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"] },
  { id: "abacus", name: "Abacus.AI (RouteLLM)", baseUrl: "https://routellm.abacus.ai/v1", models: ["route-llm"] },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", models: ["llama3.2", "qwen2.5", "mistral"], local: true },
  { id: "custom", baseUrl: "", models: [] },
]);

/**
 * @param {unknown} id
 * @returns {AiPreset | undefined}
 */
export function findPreset(id) {
  return AI_PRESETS.find((preset) => preset.id === id);
}

/**
 * Servicios que se pueden elegir: los locales solo si el servidor los admite.
 * @param {{ allowPrivate?: boolean }} [options]
 * @returns {AiPreset[]}
 */
export function visiblePresets({ allowPrivate = false } = {}) {
  return AI_PRESETS.filter((preset) => allowPrivate || !preset.local);
}

/**
 * Servicio al que corresponde el «servidor» que muestra la vista de la clave (`baseUrlHost`, p. ej. `api.groq.com`).
 * @param {string | null | undefined} host
 * @returns {string}
 */
export function presetForHost(host) {
  if (typeof host !== "string" || host.trim() === "") return "openai";
  const wanted = host.trim().toLowerCase();
  const match = AI_PRESETS.find((preset) => preset.baseUrl !== "" && new URL(preset.baseUrl).host === wanted);
  return match ? match.id : "custom";
}

/**
 * Servicio al que corresponde una URL base escrita a mano.
 * @param {string | null | undefined} url
 * @returns {string}
 */
export function presetForUrl(url) {
  if (typeof url !== "string" || url.trim() === "") return "openai";
  try {
    return presetForHost(new URL(url.trim()).host);
  } catch {
    return "custom";
  }
}
