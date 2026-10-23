// Pantalla de confirmación de una invitación (ADR 0019): «¿Deseas unirte a este espacio?». Muestra el nombre del espacio y el rol que
// se ofrece, y NO hace nada hasta un clic explícito en «Unirme». Es un <dialog> modal: el resto de la página queda inerte detrás.
// Todo texto entra con textContent.

import { clearInvite, rememberJoined } from "../api/invite.js";
import { acceptPendingInvite } from "../api/join.js";

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string, token: string,
 *   preview: import("../api/join.js").Preview,
 *   storage: Storage | null, session: Storage | null,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createInviteConfirm({ doc, win, baseUrl, token, preview, storage, session, t: initialT, fetchImpl }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    dialog: $("invite-confirm"),
    title: $("invite-confirm-title"),
    body: $("invite-confirm-body"),
    status: $("invite-confirm-status"),
    join: $("invite-confirm-join"),
    decline: $("invite-confirm-decline"),
    next: $("invite-confirm-continue"),
  };
  let t = initialT;
  /** @type {"ask" | "busy" | "retry" | "gone" | "no_switch"} */
  let phase = "ask";
  let joinedName = preview.tenant.name;

  function render() {
    els.title.textContent = t("invite.confirm.title");
    els.body.textContent = t("invite.confirm.body", { name: preview.tenant.name, role: t(`role.${preview.role}`) });
    const message = phase === "retry" ? t("invite.confirm.retry") : phase === "gone" ? t("invite.failed") : phase === "no_switch" ? t("invite.confirm.noSwitch", { name: joinedName }) : "";
    els.status.textContent = message;
    els.status.hidden = message === "";
    const asking = phase === "ask" || phase === "busy" || phase === "retry";
    els.join.hidden = !asking;
    els.decline.hidden = !asking;
    els.join.disabled = phase === "busy";
    els.decline.disabled = phase === "busy";
    els.next.hidden = asking;
    els.join.textContent = t("invite.confirm.join");
    els.decline.textContent = t("invite.confirm.decline");
    els.next.textContent = t("invite.confirm.continue");
  }

  function open() {
    if (typeof els.dialog.showModal === "function" && !els.dialog.open) els.dialog.showModal();
    else els.dialog.hidden = false;
  }

  function close() {
    if (typeof els.dialog.close === "function" && els.dialog.open) els.dialog.close();
    els.dialog.hidden = true;
  }

  async function join() {
    phase = "busy";
    render();
    const result = await acceptPendingInvite({ baseUrl, token, storage, fetchImpl });
    if (result.outcome === "joined") {
      rememberJoined(session, { name: result.tenant.name, role: result.role });
      joinedName = result.tenant.name;
      if (result.switched) return void win.location.reload(); // al volver, la interfaz ya está en el espacio nuevo
      phase = "no_switch";
    } else {
      phase = result.outcome === "gone" ? "gone" : "retry";
    }
    render();
  }

  function decline() {
    clearInvite(storage);
    close();
  }

  els.join.addEventListener("click", () => void join());
  els.decline.addEventListener("click", decline);
  els.next.addEventListener("click", () => (phase === "no_switch" ? win.location.reload() : close()));
  // Esc cierra el diálogo nativo: equivale a «Ahora no» (el enlace no se queda esperando para siempre).
  els.dialog.addEventListener("cancel", decline);

  render();
  open();
  return {
    /** @param {typeof initialT} next */
    refresh(next) {
      t = next;
      render();
    },
  };
}
