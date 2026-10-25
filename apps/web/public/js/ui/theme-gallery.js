// Galería de temas visuales (v1.3.0, iniciativa 3): un radiogroup accesible y una vista previa aproximada hecha con CSS.
//
//  - La vista previa usa el texto real del primer subtítulo y los datos del catálogo (domain/themes.js, domain/theme-preview.js): no hay
//    imágenes. Es una imitación, y se rotula como tal («Vista aproximada»). El render real con ffmpeg es de la fase 3.
//  - Solo el tema elegido se mueve, y solo mientras es visible; con «reducir movimiento» queda una foto fija.
//  - Los estilos se aplican con `style.setProperty` (variables CSS): la CSP no admite estilos en línea ni `style="..."`.
//  - Todo texto entra con textContent. El texto de la persona jamás se interpreta como marcado.

import { FONT_STACKS, previewStyle, previewWords, wordStates } from "../domain/theme-preview.js";
import { DEFAULT_THEME_ID, THEMES, THEME_GROUPS, themeById } from "../domain/themes.js";

/** Cada cuánto pasa la palabra activa. */
const STEP_MS = 450;

/**
 * @param {{
 *   doc: { getElementById: (id: string) => any, createElement: (tag: string) => any },
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   onChange: (themeId: string) => void,
 *   reducedMotion?: () => boolean,
 *   setInterval?: (fn: () => unknown, ms: number) => any,
 *   clearInterval?: (id: any) => void,
 *   initial?: string,
 * }} deps
 */
export function createThemeGallery({ doc, t: initialT, onChange, reducedMotion = () => false, setInterval: every = (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: stopEvery = (id) => globalThis.clearInterval(id), initial }) {
  /** @param {string} id */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = { group: $("burn-themes"), frame: $("burn-preview"), text: $("burn-preview-text"), note: $("burn-preview-note") };

  let t = initialT;
  let selected = themeById(initial).id;
  let sample = "";
  let karaoke = false;
  let tick = 0;
  let visible = true;
  /** @type {any} */
  let timer = null;
  /** @type {(theme: import("../domain/themes.js").ThemeData) => { code: string, [key: string]: unknown } | null} */
  let availability = () => null;
  /** Cada tarjeta con sus partes (no se cuelgan del botón: `name` es una propiedad real de <button>). @type {Map<string, { el: any, name: any, sample: any, desc: any }>} */
  const cards = new Map();

  els.frame.setAttribute("aria-hidden", "true"); // decorativa: el texto equivalente es la descripción del tema elegido

  /** @param {any} element @param {Record<string, string>} vars */
  const applyVars = (element, vars) => {
    for (const [name, value] of Object.entries(vars)) element.style.setProperty(name, value);
  };

  /** Pinta palabras como `<span>` con su estado (texto plano). @param {any} container @param {string[]} words @param {string[]} states */
  function paintWords(container, words, states) {
    container.replaceChildren(
      ...words.map((word, index) => {
        const span = doc.createElement("span");
        span.className = "cf-word";
        span.dataset.state = states[index] ?? "idle";
        span.textContent = word;
        return span;
      }),
    );
  }

  const sampleWords = () => t("theme.sample").split(/\s+/).filter(Boolean);
  const unavailable = (/** @type {import("../domain/themes.js").ThemeData} */ theme) => availability(theme);

  function paintPreview() {
    const theme = themeById(selected);
    const { mode, vars } = previewStyle(theme, { karaoke });
    applyVars(els.frame, vars);
    els.frame.dataset.frame = theme.group === "vertical" ? "vertical" : "source";
    els.frame.dataset.mode = mode;
    const words = previewWords(theme, sample, sampleWords());
    paintWords(els.text, words, wordStates(mode, words.length, tick, { reduced: reducedMotion() }));
    els.note.textContent = t("theme.preview.note");
  }

  function syncTimer() {
    const theme = themeById(selected);
    const { mode } = previewStyle(theme, { karaoke });
    const words = previewWords(theme, sample, sampleWords());
    const needed = mode !== "static" && words.length > 1 && visible && !reducedMotion();
    if (needed && timer === null) {
      timer = every(() => {
        tick += 1;
        paintPreview();
      }, STEP_MS);
    } else if (!needed && timer !== null) {
      stopEvery(timer);
      timer = null;
    }
  }

  function reasonText(/** @type {{ code: string, [key: string]: unknown }} */ reason) {
    return t(`theme.unavailable.${reason.code}`, /** @type {Record<string, number>} */ (reason.maxMinutes === undefined ? {} : { max: /** @type {number} */ (reason.maxMinutes) }));
  }

  function paintCards() {
    const enabled = THEMES.filter((theme) => unavailable(theme) === null);
    const tabStop = enabled.some((theme) => theme.id === selected) ? selected : (enabled[0]?.id ?? selected);
    for (const theme of THEMES) {
      const card = /** @type {NonNullable<ReturnType<typeof cards.get>>} */ (cards.get(theme.id));
      const reason = unavailable(theme);
      card.el.setAttribute("aria-checked", String(theme.id === selected));
      card.el.setAttribute("aria-disabled", String(reason !== null));
      card.el.setAttribute("tabindex", theme.id === tabStop ? "0" : "-1");
      card.el.setAttribute("aria-label", t(`theme.${theme.id}`));
      card.el.classList.toggle("is-selected", theme.id === selected);
      card.el.classList.toggle("is-disabled", reason !== null);
      card.name.textContent = t(`theme.${theme.id}`);
      card.desc.textContent = reason === null ? t(`theme.${theme.id}.desc`) : `${t(`theme.${theme.id}.desc`)} ${reasonText(reason)}`;
      const { vars, mode } = previewStyle(theme, {});
      applyVars(card.sample, vars);
      const words = previewWords(theme, sample, sampleWords()).slice(0, 2);
      paintWords(card.sample, words, wordStates(mode, words.length, 0, { reduced: true }));
    }
  }

  function build() {
    cards.clear();
    els.group.setAttribute("role", "radiogroup");
    els.group.setAttribute("aria-label", t("theme.title"));
    els.group.replaceChildren(
      ...THEME_GROUPS.map((group) => {
        const box = doc.createElement("div");
        box.setAttribute("role", "presentation");
        box.className = "theme-group";
        const label = doc.createElement("span");
        label.className = "theme-group__label";
        label.setAttribute("aria-hidden", "true");
        label.textContent = t(`theme.group.${group}`);
        box.append(label);
        for (const theme of THEMES.filter((candidate) => candidate.group === group)) {
          const el = doc.createElement("button");
          el.type = "button";
          el.className = "theme-card";
          el.setAttribute("role", "radio");
          el.dataset.theme = theme.id;
          const name = doc.createElement("span");
          name.className = "theme-card__name";
          const sampleEl = doc.createElement("span");
          sampleEl.className = "theme-card__sample";
          sampleEl.setAttribute("aria-hidden", "true");
          const desc = doc.createElement("span");
          desc.className = "theme-card__desc";
          desc.id = `theme-desc-${theme.id}`;
          el.setAttribute("aria-describedby", desc.id);
          el.append(sampleEl, name, desc);
          el.addEventListener("click", () => choose(theme.id, false));
          el.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => onKey(event, theme.id));
          cards.set(theme.id, { el, name, sample: sampleEl, desc });
          box.append(el);
        }
        return box;
      }),
    );
  }

  /** Elige un tema. `focus`: mover el foco (teclado). Un gesto avisa; un cambio de programa (`select`) no. */
  function choose(/** @type {string} */ id, /** @type {boolean} */ focus) {
    const theme = themeById(id);
    if (unavailable(theme) !== null) return;
    const changed = theme.id !== selected;
    selected = theme.id;
    tick = 0;
    paintCards();
    paintPreview();
    syncTimer();
    if (focus) cards.get(selected)?.el.focus();
    if (changed) onChange(selected);
  }

  function onKey(/** @type {KeyboardEvent} */ event, /** @type {string} */ id) {
    const enabled = THEMES.filter((theme) => unavailable(theme) === null).map((theme) => theme.id);
    if (enabled.length === 0 || unavailable(themeById(id)) !== null) return;
    const at = enabled.indexOf(id);
    /** @type {string | undefined} */
    let target;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = enabled[(at + 1) % enabled.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") target = enabled[0];
    else if (event.key === "End") target = enabled[enabled.length - 1];
    else if (event.key === " " || event.key === "Enter") target = id;
    if (target === undefined) return;
    event.preventDefault();
    choose(target, true);
  }

  build();
  paintCards();
  paintPreview();
  syncTimer();

  // Solo se anima lo que se ve: fuera de pantalla el ciclo se detiene.
  const Observer = /** @type {any} */ (globalThis).IntersectionObserver;
  if (typeof Observer === "function") {
    try {
      new Observer((/** @type {{ isIntersecting: boolean }[]} */ entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        syncTimer();
      }).observe(els.frame);
    } catch {
      // sin observador la vista previa se anima siempre: no es un fallo
    }
  }

  return {
    get value() {
      return selected;
    },
    /** Cambia el tema sin avisar (un cambio de programa, no un gesto). @param {string} id */
    select(id) {
      const theme = themeById(id);
      selected = unavailable(theme) === null ? theme.id : selected;
      tick = 0;
      paintCards();
      paintPreview();
      syncTimer();
    },
    /** Qué temas se pueden usar ahora. Si el elegido deja de poder usarse, pasa al tema por defecto (o al primero disponible) y lo avisa. @param {typeof availability} next */
    setAvailability(next) {
      availability = next;
      if (unavailable(themeById(selected)) !== null) {
        const fallback = unavailable(themeById(DEFAULT_THEME_ID)) === null ? themeById(DEFAULT_THEME_ID) : THEMES.find((theme) => unavailable(theme) === null);
        if (fallback) {
          selected = fallback.id;
          tick = 0;
          paintCards();
          paintPreview();
          syncTimer();
          onChange(selected);
          return;
        }
      }
      paintCards();
      syncTimer();
    },
    /** El texto del primer subtítulo, para que la vista previa lo use. @param {unknown} text */
    setSample(text) {
      sample = typeof text === "string" ? text : "";
      tick = 0;
      paintCards();
      paintPreview();
      syncTimer();
    },
    /** @param {boolean} on */
    setKaraoke(on) {
      karaoke = on === true;
      tick = 0;
      paintPreview();
      syncTimer();
    },
    /** Repinta los textos en otro idioma, conservando la elección. @param {typeof initialT} [next] */
    refresh(next) {
      if (next) t = next;
      build();
      paintCards();
      paintPreview();
    },
    stop() {
      if (timer !== null) stopEvery(timer);
      timer = null;
    },
  };
}

export { FONT_STACKS };
