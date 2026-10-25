// Asistente (v1.3.1, ADR 0028): botón flotante y panel de chat con la IA propia de la persona. Solo existe en modo local (el servidor lo
// anuncia en las capacidades). El estado puro vive en domain/assistant.js y domain/assistant-actions.js; aquí solo hay DOM. Todo texto entra
// con textContent: lo que responda la IA es un dato, nunca HTML. La IA PROPONE acciones; cada una es una tarjeta y solo se ejecuta (accionando
// los botones de la propia página) si la persona pulsa «Aplicar». Lo que cuesta pasa además por la confirmación de gasto de la página.

import { sendChat } from "../api/assistant.js";
import { ApiError } from "../api/errors.js";
import { findPreset, visiblePresets } from "../domain/ai-presets.js";
import { planAction } from "../domain/assistant-actions.js";
import { MAX_TEXT, addTurn, aiPayload, canSend, dismissAssistant, forgetAi, loadAssistant, restoreAssistant, saveAssistant, toMessages } from "../domain/assistant.js";

/**
 * @param {{
 *   doc: Document, baseUrl: string,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   storage: import("../domain/assistant.js").StorageLike | null,
 *   jobId?: () => string | null,
 *   isAudio?: () => boolean,
 *   languageName?: (code: string) => string,
 *   announce?: (text: string) => void,
 *   send?: typeof sendChat,
 * }} deps
 */
export function createAssistant({ doc, baseUrl, t: initialT, storage, jobId = () => null, isAudio = () => false, languageName = (code) => code, announce = () => {}, send = sendChat }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    fab: $("assistant-open"), panel: $("assistant"), close: $("assistant-close"), setup: $("assistant-setup"), service: $("assistant-service"),
    urlLabel: $("assistant-url-label"), url: $("assistant-url"), key: $("assistant-key"), model: $("assistant-model"), models: $("assistant-models"),
    save: $("assistant-save"), forget: $("assistant-forget"), log: $("assistant-log"), status: $("assistant-status"), form: $("assistant-form"),
    input: $("assistant-input"), send: $("assistant-send"), dismiss: $("assistant-dismiss"), restore: $("assistant-restore"),
  };

  let t = initialT;
  let enabled = false;
  let allowPrivate = false;
  let open = false;
  let busy = false;
  let prefs = loadAssistant(storage);
  /** @type {import("../domain/assistant.js").Turn[]} */
  let turns = [];
  /** @type {AbortController | null} */
  let pending = null;

  const presetLabel = (/** @type {string} */ id) => {
    const preset = findPreset(id);
    if (!preset) return id;
    if (preset.name === undefined) return t(`extkeys.preset.${id}`);
    return preset.local ? `${preset.name} (${t("extkeys.preset.local")})` : preset.name;
  };

  /** Lo que hay escrito en el formulario de «Mi IA». @returns {import("../domain/assistant.js").AiChoice} */
  const readChoice = () => ({ preset: els.service.value || "openai", key: els.key.value, model: els.model.value, baseUrl: els.url.value });

  function fillSelect() {
    const wanted = els.service.value || prefs.ai?.preset || "openai";
    els.service.replaceChildren(
      ...visiblePresets({ allowPrivate }).map((preset) => {
        const option = doc.createElement("option");
        option.value = preset.id;
        option.textContent = presetLabel(preset.id);
        return option;
      }),
    );
    els.service.value = visiblePresets({ allowPrivate }).some((preset) => preset.id === wanted) ? wanted : "openai";
  }

  function syncPreset() {
    const preset = findPreset(els.service.value);
    const custom = preset?.id === "custom";
    els.url.hidden = !custom;
    els.urlLabel.hidden = !custom;
    els.models.replaceChildren(
      ...(preset?.models ?? []).map((name) => {
        const option = doc.createElement("option");
        option.value = name;
        return option;
      }),
    );
  }

  /** Una operación sobre un botón o campo de la página. Falla (sin lanzar) si no existe, está oculto o desactivado. @param {import("../domain/assistant-actions.js").Op} op */
  function runOp(op) {
    const element = /** @type {any} */ (doc.getElementById(op.id));
    if (!element || element.closest("[hidden]") !== null || element.disabled) return false;
    if (op.type === "click") {
      element.click();
      return true;
    }
    if (op.type === "select") {
      if (![...element.options].some((/** @type {HTMLOptionElement} */ option) => option.value === op.value)) return false;
      element.value = op.value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    element.value = op.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  /** @param {import("../domain/assistant.js").TurnAction} action */
  function actionText(action) {
    const args = action.args;
    switch (action.name) {
      case "go_to_step":
        return t("assistant.action.go_to_step", { step: t(`assistant.step.${String(args.step)}`) });
      case "translate":
        return t("assistant.action.translate", { language: languageName(String(args.targetLanguage)), provider: t(`assistant.provider.${String(args.provider)}`) });
      case "dub":
        return t("assistant.action.dub");
      case "burn":
        return t("assistant.action.burn");
      default:
        return t("assistant.action.download_srt");
    }
  }

  /** La persona pulsó «Aplicar» en una tarjeta. @param {import("../domain/assistant.js").TurnAction} action */
  function applyAction(action) {
    const plan = planAction(action, { audio: isAudio() });
    if (!plan.ok) {
      action.state = "failed";
      action.reason = plan.reason === "audio" ? t("assistant.action.audio") : t("assistant.action.failed");
    } else {
      // Se comprueba todo antes de tocar nada: o se aplica entera o no se cambia ningún campo.
      const ready = plan.ops.every((op) => {
        const element = /** @type {any} */ (doc.getElementById(op.id));
        return element && element.closest("[hidden]") === null && !element.disabled && (op.type !== "select" || [...element.options].some((/** @type {HTMLOptionElement} */ option) => option.value === op.value));
      });
      if (ready && plan.ops.every(runOp)) action.state = "applied";
      else {
        action.state = "failed";
        action.reason = t("assistant.action.failed");
      }
    }
    renderLog();
    announce(action.state === "applied" ? t("assistant.action.applied") : (action.reason ?? ""));
  }

  /** @param {import("../domain/assistant.js").TurnAction} action */
  function actionCard(action) {
    const card = doc.createElement("div");
    card.className = "assistant__action";
    const label = doc.createElement("p");
    label.className = "assistant__action-text";
    label.textContent = actionText(action);
    card.append(label);
    const plan = planAction(action, { audio: isAudio() });
    if (action.state === "pending") {
      if (plan.ok && plan.spend) {
        const note = doc.createElement("p");
        note.className = "panel__detail";
        note.textContent = t("assistant.action.spend");
        card.append(note);
      }
      const row = doc.createElement("div");
      row.className = "assistant__actions";
      const apply = doc.createElement("button");
      apply.type = "button";
      apply.className = "btn btn--primary btn--small";
      apply.textContent = t("assistant.action.apply");
      apply.addEventListener("click", () => applyAction(action));
      const dismiss = doc.createElement("button");
      dismiss.type = "button";
      dismiss.className = "btn btn--ghost btn--small";
      dismiss.textContent = t("assistant.action.dismiss");
      dismiss.addEventListener("click", () => {
        action.state = "dismissed";
        renderLog();
      });
      row.append(apply, dismiss);
      card.append(row);
    } else {
      const state = doc.createElement("p");
      state.className = "panel__detail";
      state.textContent = action.state === "applied" ? t("assistant.action.applied") : action.state === "dismissed" ? t("assistant.action.dismissed") : (action.reason ?? t("assistant.action.failed"));
      card.append(state);
    }
    return card;
  }

  function renderLog() {
    els.log.replaceChildren(
      ...turns.map((turn) => {
        const item = doc.createElement("li");
        item.className = `assistant__turn assistant__turn--${turn.role}`;
        const who = doc.createElement("span");
        who.className = "assistant__who";
        who.textContent = t(turn.role === "user" ? "assistant.you" : "assistant.bot");
        item.append(who);
        // Un turno que solo trae acciones no repite el texto interno del historial.
        if (!(turn.actions && turn.actions.length > 0 && /^\(.*\)$/.test(turn.content))) {
          const body = doc.createElement("span");
          body.textContent = turn.content;
          item.append(body);
        }
        for (const action of turn.actions ?? []) item.append(actionCard(action));
        return item;
      }),
    );
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderState() {
    const visible = enabled && !prefs.hidden;
    els.fab.hidden = !visible || open;
    els.fab.setAttribute("aria-expanded", String(open));
    els.panel.hidden = !visible || !open;
    els.restore.hidden = !(enabled && prefs.hidden);
    els.send.disabled = busy;
    els.input.disabled = busy;
  }

  function setStatus(/** @type {string} */ message) {
    els.status.textContent = message;
  }

  function applyPrefsToForm() {
    if (prefs.ai) {
      els.service.value = prefs.ai.preset;
      els.key.value = prefs.ai.key;
      els.model.value = prefs.ai.model;
      els.url.value = prefs.ai.baseUrl;
    }
    syncPreset();
  }

  function openPanel() {
    if (!enabled || prefs.hidden) return;
    open = true;
    renderState();
    // Sin IA configurada, lo primero es «Mi IA».
    if (aiPayload(prefs.ai) === null) els.setup.open = true;
    (aiPayload(prefs.ai) === null ? els.key : els.input).focus();
  }

  function closePanel() {
    open = false;
    renderState();
    els.fab.focus();
  }

  function errorText(/** @type {unknown} */ error) {
    const code = error instanceof ApiError ? error.code : "";
    return code === "invalid_ai_config" || code === "ai_unavailable" ? t(`assistant.err.${code}`) : t("assistant.err.generic");
  }

  async function submit() {
    const text = els.input.value;
    const ai = aiPayload(prefs.ai);
    if (ai === null) {
      setStatus(t("assistant.need.ai"));
      els.setup.open = true;
      return;
    }
    if (!canSend({ text, ai: prefs.ai, busy }) || text.trim().length > MAX_TEXT) return;
    turns = addTurn(turns, "user", text);
    els.input.value = "";
    busy = true;
    setStatus(t("assistant.thinking"));
    renderLog();
    renderState();
    pending = new AbortController();
    try {
      const { reply, actions } = await send({ baseUrl, messages: toMessages(turns), ai, ...(jobId() ? { jobId: /** @type {string} */ (jobId()) } : {}), signal: pending.signal });
      turns = addTurn(turns, "assistant", reply, actions);
      setStatus("");
      announce((reply || actionText({ name: actions[0]?.name ?? "", args: actions[0]?.args ?? {} })).slice(0, 120));
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "aborted")) setStatus(errorText(error));
    } finally {
      pending = null;
      busy = false;
      renderLog();
      renderState();
      if (open) els.input.focus();
    }
  }

  els.fab.addEventListener("click", openPanel);
  els.close.addEventListener("click", closePanel);
  els.service.addEventListener("change", syncPreset);
  els.save.addEventListener("click", () => {
    const choice = readChoice();
    if (aiPayload(choice) === null) {
      setStatus(t("assistant.err.invalid_ai_config"));
      return;
    }
    prefs = { ...prefs, ai: choice };
    setStatus(saveAssistant(storage, prefs) ? t("assistant.saved") : t("assistant.saved.session"));
    els.setup.open = false;
  });
  els.forget.addEventListener("click", () => {
    pending?.abort();
    prefs = { ...prefs, ai: null };
    forgetAi(storage);
    els.key.value = "";
    els.model.value = "";
    els.url.value = "";
    setStatus(t("assistant.forgotten"));
  });
  els.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void submit();
  });
  // Enter envía; Mayús+Enter hace salto de línea.
  els.input.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  els.panel.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
    if (event.key === "Escape") closePanel();
  });
  els.dismiss.addEventListener("click", () => {
    pending?.abort();
    dismissAssistant(storage);
    prefs = { ...prefs, hidden: true };
    open = false;
    renderState();
    els.restore.focus();
  });
  els.restore.addEventListener("click", () => {
    restoreAssistant(storage);
    prefs = { ...prefs, hidden: false };
    renderState();
    openPanel();
  });

  fillSelect();
  applyPrefsToForm();
  renderState();

  return {
    /** Lo que anuncia el servidor: sin `enabled` el asistente no existe en la página. @param {{ enabled: boolean, allowPrivateBaseUrls: boolean }} caps */
    applyCapabilities(caps) {
      enabled = caps.enabled;
      allowPrivate = caps.enabled && caps.allowPrivateBaseUrls;
      fillSelect();
      applyPrefsToForm();
      renderState();
    },
    /** Repinta los textos al cambiar de idioma. @param {typeof t} next */
    refresh(next) {
      t = next;
      fillSelect();
      applyPrefsToForm();
      renderLog();
    },
    get isOpen() {
      return open;
    },
  };
}
