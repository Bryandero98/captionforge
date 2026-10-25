// Asistente (v1.3.1, ADR 0028) como funciones puras: preferencias en el navegador, IA elegida y conversación. Sin DOM.
// La clave de la IA se guarda SOLO en este navegador (localStorage) y viaja en cada mensaje; el servidor no la guarda. Si el
// almacenamiento está bloqueado todo sigue funcionando durante la visita, solo que hay que volver a pegarla.

import { findPreset } from "./ai-presets.js";

/** @typedef {{ preset: string, key: string, model: string, baseUrl: string }} AiChoice */
/** @typedef {{ hidden: boolean, ai: AiChoice | null }} AssistantPrefs */
/** @typedef {{ name: string, args: Record<string, unknown>, state?: "pending" | "applied" | "dismissed" | "failed", reason?: string }} TurnAction */
/** @typedef {{ role: "user" | "assistant", content: string, actions?: TurnAction[] }} Turn */
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

/**
 * Agrega un turno. Un turno del asistente puede traer solo acciones: el texto del historial que se reenvía a la IA no puede quedar vacío.
 * @param {Turn[]} turns @param {string} role @param {string} content @param {TurnAction[]} [actions] @returns {Turn[]}
 */
export function addTurn(turns, role, content, actions = []) {
  const clean = content.trim() === "" && actions.length > 0 ? `(${actions.map((action) => action.name).join(", ")})` : content.trim();
  if ((role !== "user" && role !== "assistant") || clean === "") return turns;
  const turn = { role: /** @type {"user" | "assistant"} */ (role), content: clean, ...(actions.length > 0 ? { actions: actions.map((action) => ({ ...action, state: "pending" })) } : {}) };
  return [...turns, /** @type {Turn} */ (turn)].slice(-MAX_TURNS);
}

/** Lo que se reenvía a la IA: solo rol y texto, nunca las acciones ni su estado. @param {Turn[]} turns */
export const toMessages = (turns) => turns.map(({ role, content }) => ({ role, content }));

/** @param {{ text: string, ai: AiChoice | null, busy: boolean }} state */
export function canSend({ text: draft, ai, busy }) {
  const clean = draft.trim();
  return !busy && clean !== "" && clean.length <= MAX_TEXT && aiPayload(ai) !== null;
}
