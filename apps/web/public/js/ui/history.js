// Lista «Recientes»: los trabajos que este navegador subió (ver domain/history.js). Persiste en localStorage; sin él
// (modo privado, almacenamiento bloqueado) la lista dura solo la visita y nada falla.

import { MAX_ENTRIES, addEntry, parseHistory, removeEntry } from "../domain/history.js";

const KEY = "captionforge_jobs";

/** @typedef {import("../domain/history.js").HistoryEntry} HistoryEntry */

/**
 * @param {{
 *   doc: Document, win: Window, t: (key: string, params?: Record<string, string | number>) => string, lang: () => string,
 *   onOpen: (entry: HistoryEntry) => void,
 * }} deps
 */
export function createHistory({ doc, win, t, lang, onOpen }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const list = $("history-list");
  const empty = $("history-empty");

  /** @type {HistoryEntry[]} */
  let entries = read();

  function read() {
    try {
      return parseHistory(win.localStorage.getItem(KEY));
    } catch {
      return [];
    }
  }

  function save() {
    try {
      win.localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // sin almacenamiento: la lista dura solo esta visita
    }
  }

  function when(/** @type {number} */ at) {
    try {
      return new Date(at).toLocaleString(lang(), { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return new Date(at).toISOString();
    }
  }

  function render() {
    empty.hidden = entries.length > 0;
    list.replaceChildren(
      ...entries.map((entry) => {
        const item = doc.createElement("li");
        item.className = "history__item";
        const name = doc.createElement("span");
        name.className = "history__name";
        name.textContent = entry.name;
        const meta = doc.createElement("span");
        meta.className = "history__meta";
        meta.textContent = `${t(`history.kind.${entry.kind}`)} · ${when(entry.at)}`;
        const open = doc.createElement("button");
        open.type = "button";
        open.className = "btn btn--secondary";
        open.textContent = t("history.open");
        open.setAttribute("aria-label", t("history.open.label", { name: entry.name }));
        open.addEventListener("click", () => onOpen(entry));
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "btn btn--ghost";
        remove.textContent = t("history.remove");
        remove.setAttribute("aria-label", t("history.remove.label", { name: entry.name }));
        remove.addEventListener("click", () => {
          const next = entries.findIndex((other) => other.id === entry.id);
          entries = removeEntry(entries, entry.id);
          save();
          render();
          // El botón pulsado desaparece: el foco pasa al siguiente «Abrir» (o al anterior, o a la lista vacía).
          const buttons = list.querySelectorAll(".history__item .btn--secondary");
          const target = buttons[Math.min(next, buttons.length - 1)];
          if (target) target.focus();
        });
        item.append(name, meta, open, remove);
        return item;
      }),
    );
  }

  // Otra pestaña del mismo navegador cambió la lista.
  win.addEventListener("storage", (/** @type {StorageEvent} */ event) => {
    if (event.key !== KEY) return;
    entries = read();
    render();
  });

  render();
  return {
    /** @param {HistoryEntry} entry */
    add(entry) {
      entries = addEntry(entries, entry);
      save();
      render();
    },
    refresh: render,
    get entries() {
      return entries;
    },
    max: MAX_ENTRIES,
  };
}
