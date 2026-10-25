// Guía interactiva (v1.3.1): una tarjeta que enseña un paso a la vez. Se abre sola SOLO la primera vez; el botón «Ayuda» la reabre.
// El estado vive en domain/tour.js (puro). Aquí solo hay DOM: textos con textContent, foco y desplazamiento hacia el elemento del paso.

import { TOUR_STEPS, closeTour, goNext, goPrevious, markTourSeen, openTour, shouldAutoOpen } from "../domain/tour.js";

/**
 * @param {{
 *   doc: Document, win: Window, t: (key: string, params?: Record<string, string | number>) => string,
 *   storage: import("../domain/tour.js").StorageLike | null,
 *   reducedMotion?: () => boolean,
 * }} deps
 */
export function createTour({ doc, win, t: initialT, storage, reducedMotion = () => false }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = { card: $("tour"), count: $("tour-count"), title: $("tour-title"), body: $("tour-body"), prev: $("tour-prev"), next: $("tour-next"), close: $("tour-close"), help: $("help-open") };

  let t = initialT;
  /** @type {import("../domain/tour.js").TourState} */
  let state = { open: false, index: 0 };
  /** @type {HTMLElement | null} */
  let highlighted = null;

  function clearHighlight() {
    highlighted?.classList.remove("tour-focus");
    highlighted = null;
  }

  function render() {
    els.card.hidden = !state.open;
    els.help.setAttribute("aria-expanded", String(state.open));
    if (!state.open) {
      clearHighlight();
      return;
    }
    const step = /** @type {NonNullable<(typeof TOUR_STEPS)[number]>} */ (TOUR_STEPS[state.index]);
    const last = state.index === TOUR_STEPS.length - 1;
    els.count.textContent = t("tour.count", { n: state.index + 1, total: TOUR_STEPS.length });
    els.title.textContent = t(`tour.step.${step.id}.title`);
    els.body.textContent = t(`tour.step.${step.id}.body`);
    els.prev.disabled = state.index === 0;
    els.next.textContent = last ? t("tour.done") : t("tour.next");
    clearHighlight();
    const target = doc.getElementById(step.target);
    if (target !== null && !target.hidden && target.getClientRects().length > 0) {
      target.classList.add("tour-focus");
      highlighted = target;
      target.scrollIntoView?.({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  function open() {
    state = openTour();
    render();
    els.card.focus({ preventScroll: true });
  }

  function close() {
    if (!state.open) return;
    state = closeTour(state);
    markTourSeen(storage);
    render();
    els.help.focus();
  }

  els.help.addEventListener("click", () => (state.open ? close() : open()));
  els.prev.addEventListener("click", () => {
    state = goPrevious(state);
    render();
  });
  els.next.addEventListener("click", () => {
    if (state.index === TOUR_STEPS.length - 1) {
      close();
      return;
    }
    state = goNext(state);
    render();
  });
  els.close.addEventListener("click", close);
  els.card.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  });

  if (shouldAutoOpen(storage)) {
    // Tras el primer pintado: así el foco y el desplazamiento no pelean con la carga de la página.
    win.setTimeout(open, 0);
  }

  return {
    open,
    close,
    get isOpen() {
      return state.open;
    },
    /** Repinta los textos al cambiar de idioma. @param {typeof t} next */
    refresh(next) {
      t = next;
      render();
    },
  };
}
