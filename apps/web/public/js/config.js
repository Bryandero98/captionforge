// Configuración de despliegue de la interfaz, leída de <meta> para que cambiarla no exija tocar el código:
//   <meta name="cf-api-base" content="">            base del API; vacío = mismo origen (lo normal: sin CORS)
//   <meta name="cf-max-upload-bytes" content="...">  tamaño máximo que anuncia el API (MAX_UPLOAD_BYTES)

import { DEFAULT_MAX_BYTES } from "./api/upload.js";

/** Solo http(s) absoluto o una ruta del mismo origen: nada de javascript:, data: ni //otro-origen. */
function safeBase(/** @type {string | null | undefined} */ raw) {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(value)) return value;
  if (/^\/[^/\s]/.test(value)) return value;
  return "";
}

/** @param {{ querySelector(selector: string): { getAttribute(name: string): string | null } | null }} doc */
export function readConfig(doc) {
  const meta = (/** @type {string} */ name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content");
  const rawMax = (meta("cf-max-upload-bytes") ?? "").trim();
  const max = /^\d+$/.test(rawMax) ? Number(rawMax) : 0;
  return { baseUrl: safeBase(meta("cf-api-base")), maxBytes: Number.isSafeInteger(max) && max > 0 ? max : DEFAULT_MAX_BYTES };
}
