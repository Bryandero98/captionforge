// Historial de trabajos del navegador. El API no tiene un listado (no hay cuentas todavía), así que cada navegador guarda
// los ids de lo que subió, y solo eso: id, nombre, tipo y fecha. Nada de subtítulos ni de contenido. Se lee con
// desconfianza: lo que haya en el almacenamiento puede venir de una versión vieja o de otra pestaña.

export const MAX_ENTRIES = 20;
const MAX_NAME = 255;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @typedef {{ id: string, name: string, kind: "TRANSCRIBE" | "BURN", at: number, parentId?: string }} HistoryEntry */

/** @param {unknown} value @returns {HistoryEntry | null} */
function cleanEntry(value) {
  if (value === null || typeof value !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (typeof raw.id !== "string" || !UUID.test(raw.id)) return null;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return null;
  if (raw.kind !== "TRANSCRIBE" && raw.kind !== "BURN") return null;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  /** @type {HistoryEntry} */
  const entry = { id: raw.id.toLowerCase(), name: raw.name.slice(0, MAX_NAME), kind: raw.kind, at: raw.at };
  if (typeof raw.parentId === "string" && UUID.test(raw.parentId)) entry.parentId = raw.parentId.toLowerCase();
  return entry;
}

/**
 * @param {string | null | undefined} raw
 * @returns {HistoryEntry[]}
 */
export function parseHistory(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  /** @type {HistoryEntry[]} */
  const list = [];
  for (const item of value) {
    const entry = cleanEntry(item);
    if (entry !== null && !list.some((other) => other.id === entry.id)) list.push(entry);
    if (list.length === MAX_ENTRIES) break;
  }
  return list;
}

/**
 * Lo más nuevo primero; un id repetido sube al principio.
 * @param {HistoryEntry[]} list
 * @param {HistoryEntry} entry
 */
export function addEntry(list, entry) {
  return [entry, ...list.filter((other) => other.id !== entry.id)].slice(0, MAX_ENTRIES);
}

/**
 * @param {HistoryEntry[]} list
 * @param {string} id
 */
export function removeEntry(list, id) {
  return list.filter((entry) => entry.id !== id);
}
