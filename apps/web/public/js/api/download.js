// Descargas de artefactos con autenticación. Un <a href> o un <video src> no pueden mandar la cabecera X-API-Key, así que
// el archivo se pide con fetch (que sí la manda) y se entrega como Blob. Límite conocido: el Blob vive en memoria, por eso
// la vista previa del video tiene tope (PREVIEW_MAX_BYTES); un enlace firmado de corta vida lo resolvería (pendiente).

import { authHeaders } from "./auth.js";
import { errorFromResponse } from "./errors.js";
import { artifactUrl } from "./jobs.js";

/** Más grande que esto, el video se descarga pero no se previsualiza en la página. */
export const PREVIEW_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Pide un artefacto con la clave de API. Lanza ApiError si el servidor responde con un error.
 * @param {{ baseUrl: string, jobId: string, name: "srt" | "segments" | "waveform" | "video", signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Response>}
 */
export async function fetchArtifact({ baseUrl, jobId, name, signal, fetchImpl = (...args) => fetch(...args) }) {
  const response = await fetchImpl(artifactUrl(baseUrl, jobId, name), { headers: authHeaders(), cache: "no-store", signal });
  if (!response.ok) throw errorFromResponse(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
  return response;
}

/**
 * Entrega un Blob como descarga del navegador.
 * @param {{ doc: Document, win: Window, blob: Blob, filename: string }} options
 */
export function saveBlobAs({ doc, win, blob, filename }) {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  doc.body.append(link);
  link.click();
  link.remove();
  win.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
