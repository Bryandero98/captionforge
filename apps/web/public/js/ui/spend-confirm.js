// Confirmación del gasto (ADR 0020): antes de mandar texto a un proveedor externo, que cobra a la persona, se muestra una estimación
// en un <dialog> modal y se espera un clic explícito. El foco empieza en «Cancelar» y Esc cancela: Enter no gasta por descuido.
// Todo texto entra con textContent.

import { estimateTokens, formatCount } from "../domain/spend.js";

/**
 * @param {{ doc: Document, t: (key: string, params?: Record<string, string | number>) => string }} deps
 */
export function createSpendConfirm({ doc, t: initialT }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = { dialog: $("spend-confirm"), title: $("spend-confirm-title"), body: $("spend-confirm-body"), yes: $("spend-confirm-yes"), no: $("spend-confirm-no") };

  let t = initialT;
  /** @type {{ provider: string, characters: number, model?: string, host?: string } | null} */
  let pending = null;
  /** @type {((accepted: boolean) => void) | null} */
  let resolve = null;
  /** El control que tenía el foco al abrir: el foco vuelve a él al cerrar. @type {any} */
  let opener = null;

  function render() {
    els.title.textContent = t("spend.title");
    els.yes.textContent = t("spend.confirm");
    els.no.textContent = t("spend.cancel");
    els.body.textContent = pending === null ? "" : [t("spend.body", { provider: t(`extkeys.provider.${pending.provider}`), characters: formatCount(pending.characters, doc.documentElement.lang || "es"), tokens: formatCount(estimateTokens(pending.characters), doc.documentElement.lang || "es") }), ...(pending.host ? [t("spend.custom.host", { host: pending.host })] : []), ...(pending.model ? [t("spend.custom.model", { model: pending.model })] : [])].join(" ");
  }

  function open() {
    if (typeof els.dialog.showModal === "function") {
      if (!els.dialog.open) els.dialog.showModal();
    } else {
      els.dialog.hidden = false;
    }
    els.no.focus();
  }

  function close() {
    if (typeof els.dialog.close === "function") {
      if (els.dialog.open) els.dialog.close();
    } else {
      els.dialog.hidden = true;
    }
  }

  /** @param {boolean} accepted */
  function settle(accepted) {
    const done = resolve;
    resolve = null;
    pending = null;
    close();
    if (opener !== null && !opener.disabled && typeof opener.focus === "function") opener.focus();
    opener = null;
    done?.(accepted);
  }

  els.yes.addEventListener("click", () => settle(true));
  els.no.addEventListener("click", () => settle(false));
  els.dialog.addEventListener("cancel", () => settle(false));

  render();
  return {
    /**
     * Pregunta y espera la respuesta. Una pregunta nueva rechaza la anterior: nunca hay dos a la vez.
     * @param {{ provider: string, characters: number, model?: string, host?: string }} spend
     * @returns {Promise<boolean>}
     */
    ask(spend) {
      resolve?.(false);
      if (opener === null) opener = doc.activeElement ?? null;
      pending = spend;
      render();
      open();
      return new Promise((done) => {
        resolve = done;
      });
    },
    /** Cierra la pregunta pendiente como rechazada (p. ej. al cambiar de transcripción). */
    cancel() {
      if (resolve !== null) settle(false);
    },
    /** @param {typeof initialT} next */
    refresh(next) {
      t = next;
      render();
    },
  };
}
