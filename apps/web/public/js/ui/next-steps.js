// «¿Qué quieres hacer ahora?» (v1.3.1): tarjeta con las acciones posibles tras transcribir. Cada botón lleva la vista y el foco al formulario
// correspondiente; no ejecuta nada por sí misma. Un audio no ofrece «poner en el video». Todo texto entra con textContent.

import { nextSteps } from "../domain/next-steps.js";

/**
 * @param {{ doc: Document, win: Window, t: (key: string, params?: Record<string, string | number>) => string, reducedMotion?: () => boolean }} deps
 */
export function createNextSteps({ doc, t: initialT, reducedMotion = () => false }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = { card: $("next-steps"), keys: $("next-keys"), keysNote: $("next-keys-note"), videoBody: $("next-video-body"), toggle: $("account-extkeys-toggle") };
  const buttons = { srt: $("next-srt"), translate: $("next-translate"), dub: $("next-dub"), video: $("next-video") };

  let t = initialT;
  /** @type {unknown} */
  let job = null;

  /** Lleva la vista al elemento y el foco a su primer control (o a él mismo si es un enlace). @param {string} id */
  function goTo(id) {
    const target = doc.getElementById(id);
    if (target === null || target.hidden) return;
    target.scrollIntoView?.({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    const focusable = target.matches("a, button, input, select, textarea") ? target : target.querySelector("select, input, button, a");
    /** @type {HTMLElement | null} */ (focusable)?.focus({ preventScroll: true });
  }

  function render() {
    const opened = job !== null;
    els.card.hidden = !opened;
    if (!opened) return;
    for (const step of nextSteps(job)) {
      const button = buttons[step.id];
      button.disabled = !step.available;
      if (step.id === "video") els.videoBody.textContent = step.available ? t("next.video.body") : t("next.video.audio");
    }
    // «Claves externas» solo existe para quien puede guardarlas: si su botón no está a la vista, tampoco se ofrece aquí.
    const canOpenKeys = !els.toggle.hidden;
    els.keys.hidden = !canOpenKeys;
    els.keysNote.hidden = !canOpenKeys;
  }

  for (const step of nextSteps(null)) buttons[step.id].addEventListener("click", () => goTo(step.target));
  els.keys.addEventListener("click", () => {
    if (els.toggle.getAttribute("aria-expanded") !== "true") els.toggle.click();
    doc.getElementById("extkeys-panel")?.scrollIntoView?.({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  });

  return {
    /** Muestra la tarjeta para la transcripción abierta. @param {unknown} openedJob */
    show(openedJob) {
      job = openedJob ?? {};
      render();
    },
    hide() {
      job = null;
      render();
    },
    /** Repinta los textos al cambiar de idioma. @param {typeof t} next */
    refresh(next) {
      t = next;
      render();
    },
  };
}
