// Cola de subida de varios videos como funciones puras. Los archivos se suben de uno en uno (el API limita las subidas
// simultáneas por cliente); cada uno crea su propio trabajo, así que la cola solo ordena y recuerda cómo fue cada subida.
//
//   pending --markUploading--> uploading --markDone--> done
//                                  |--markError--> error | markCancelled--> cancelled   (ambos se pueden reintentar)

/** Tope de archivos en cola: evita una lista interminable y un historial desbordado. */
export const MAX_FILES = 20;

/**
 * @typedef {"pending" | "uploading" | "done" | "error" | "cancelled"} ItemStatus
 * @typedef {{ key: number, file: { name: string, size: number }, status: ItemStatus, jobId: string | null, problem: import("../api/errors.js").ApiError | null }} Item
 * @typedef {{ items: Item[], nextKey: number }} Batch
 */

/** @type {Batch} */
export const emptyBatch = Object.freeze({ items: [], nextKey: 1 });

/**
 * Añade archivos a la cola. `precheck` devuelve un ApiError si el archivo no sirve (formato, tamaño) o null.
 * @template {{ name: string, size: number }} F
 * @param {Batch} batch
 * @param {readonly F[]} files
 * @param {(file: F) => import("../api/errors.js").ApiError | null} precheck
 * @returns {{ batch: Batch, rejected: { name: string, problem: import("../api/errors.js").ApiError }[], overflow: number, duplicates: number }}
 */
export function addFiles(batch, files, precheck) {
  const items = [...batch.items];
  let nextKey = batch.nextKey;
  /** @type {{ name: string, problem: import("../api/errors.js").ApiError }[]} */
  const rejected = [];
  let overflow = 0;
  let duplicates = 0;
  for (const file of files) {
    const problem = precheck(file);
    if (problem !== null) {
      rejected.push({ name: file.name, problem });
      continue;
    }
    if (items.some((item) => item.file.name === file.name && item.file.size === file.size)) {
      duplicates++;
      continue;
    }
    if (items.length >= MAX_FILES) {
      overflow++;
      continue;
    }
    items.push({ key: nextKey++, file, status: "pending", jobId: null, problem: null });
  }
  return { batch: { items, nextKey }, rejected, overflow, duplicates };
}

/** El archivo que toca: el que está subiendo o, si no, el primero pendiente o con fallo (un fallo se reintenta antes). */
export function currentOf(/** @type {Batch} */ batch) {
  return batch.items.find((item) => item.status === "uploading") ?? batch.items.find((item) => item.status === "pending" || item.status === "error" || item.status === "cancelled") ?? null;
}

/** @param {Batch} batch @param {number} key @param {(item: Item) => Item} change */
function update(batch, key, change) {
  if (!batch.items.some((item) => item.key === key)) return batch;
  return { ...batch, items: batch.items.map((item) => (item.key === key ? change(item) : item)) };
}

/** Empieza a subir un archivo; si ya hay otro subiendo no cambia nada. */
export function markUploading(/** @type {Batch} */ batch, /** @type {number} */ key) {
  if (batch.items.some((item) => item.status === "uploading" && item.key !== key)) return batch;
  return update(batch, key, (item) => ({ ...item, status: "uploading", problem: null }));
}

export function markDone(/** @type {Batch} */ batch, /** @type {number} */ key, /** @type {string} */ jobId) {
  return update(batch, key, (item) => ({ ...item, status: "done", jobId, problem: null }));
}

export function markError(/** @type {Batch} */ batch, /** @type {number} */ key, /** @type {import("../api/errors.js").ApiError} */ problem) {
  return update(batch, key, (item) => ({ ...item, status: "error", problem }));
}

export function markCancelled(/** @type {Batch} */ batch, /** @type {number} */ key) {
  return update(batch, key, (item) => ({ ...item, status: "cancelled", problem: null }));
}

/** Quita un archivo de la cola, salvo el que se está subiendo. */
export function removeItem(/** @type {Batch} */ batch, /** @type {number} */ key) {
  const item = batch.items.find((candidate) => candidate.key === key);
  if (item === undefined || item.status === "uploading") return batch;
  return { ...batch, items: batch.items.filter((candidate) => candidate.key !== key) };
}

export function summaryOf(/** @type {Batch} */ batch) {
  const count = (/** @type {ItemStatus} */ status) => batch.items.filter((item) => item.status === status).length;
  return { total: batch.items.length, done: count("done"), failed: count("error"), pending: count("pending"), cancelled: count("cancelled"), uploading: count("uploading") };
}
