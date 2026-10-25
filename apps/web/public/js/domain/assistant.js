// Asistente (v1.3.1, ADR 0028) como funciones puras: preferencias en el navegador, IA elegida y conversación. Sin DOM.
// La clave de la IA se guarda SOLO en este navegador (localStorage) y viaja en cada mensaje; el servidor no la guarda. Si el
// almacenamiento está bloqueado todo sigue funcionando durante la visita, solo que hay que volver a pegarla.

import { findPreset } from "./ai-presets.js";

/** @typedef {{ preset: string, key: string, model: string, baseUrl: string }} AiChoice */
/** @typedef {{ hidden: boolean, ai: AiChoice | null }} AssistantPrefs */
/** @typedef {{ role: "user" | "assistant", content: string }} Turn */
/** @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem?(key: string): void }} StorageLike */

export const ASSISTANT_KEY = "cf-assistant";
export const MAX_TURNS = 20;
export const MAX_TEXT = 4000;

const isRecord = (/** @type {unknown} */ value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (/** @type {unknown} */ value) => (typeof value === "string" ? value : "");

/** @param {StorageLike | null | undefined} storage @returns {AssistantPrefs} */
export function loadAssistant(storage) {
  try {
    const raw = storage?.getItem(ASSISTANT_KEY);
    const data = typeof raw === "string" ? JSON.parse(raw) : null;
    if (!isRecord(data)) return { hidden: false, ai: null };
    const ai = isRecord(data.ai) && text(data.ai.key).trim() !== "" ? { preset: text(data.ai.preset) || "openai", key: text(data.ai.key), model: text(data.ai.model), baseUrl: text(data.ai.baseUrl) } : null;
    return { hidden: data.hidden === true, ai };
  } catch {
    return { hidden: false, ai: null };
  }
}

/** @param {StorageLike | null | undefined} storage @param {AssistantPrefs} prefs */
export function saveAssistant(storage, prefs) {
  try {
    if (!storage) return false;
    storage.setItem(ASSISTANT_KEY, JSON.stringify({ hidden: prefs.hidden, ai: prefs.ai }));
    return true;
  } catch {
    return false;
  }
}

/** Quitar el asistente de la pantalla no borra la clave guardada. @param {StorageLike | null | undefined} storage */
export const dismissAssistant = (storage) => saveAssistant(storage, { ...loadAssistant(storage), hidden: true });

/** @param {StorageLike | null | undefined} storage */
export const restoreAssistant = (storage) => saveAssistant(storage, { ...loadAssistant(storage), hidden: false });

/** Borra la clave de este navegador. @param {StorageLike | null | undefined} storage */
export const forgetAi = (storage) => saveAssistant(storage, { ...loadAssistant(storage), ai: null });

/**
 * Lo que se manda al servidor: la clave, y la dirección y el modelo si corresponden. Sin clave no hay IA.
 * @param {AiChoice | null | undefined} choice
 * @returns {{ key: string, baseUrl?: string, model?: string } | null}
 */
export function aiPayload(choice) {
  const key = choice?.key.trim() ?? "";
  if (!choice || key === "") return null;
  const preset = findPreset(choice.preset);
  const baseUrl = preset && preset.id !== "custom" ? preset.baseUrl : choice.baseUrl.trim();
  const model = choice.model.trim();
  return { key, ...(baseUrl === "" ? {} : { baseUrl }), ...(model === "" ? {} : { model }) };
}

/** @param {Turn[]} turns @param {string} role @param {string} content @returns {Turn[]} */
export function addTurn(turns, role, content) {
  const clean = content.trim();
  if ((role !== "user" && role !== "assistant") || clean === "") return turns;
  return [...turns, { role: /** @type {"user" | "assistant"} */ (role), content: clean }].slice(-MAX_TURNS);
}

/** @param {{ text: string, ai: AiChoice | null, busy: boolean }} state */
export function canSend({ text: draft, ai, busy }) {
  const clean = draft.trim();
  return !busy && clean !== "" && clean.length <= MAX_TEXT && aiPayload(ai) !== null;
}
