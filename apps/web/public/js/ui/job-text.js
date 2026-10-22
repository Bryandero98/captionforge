// Textos de estado de un trabajo, comunes al panel de la transcripción y al del quemado.

/** @typedef {(key: string, params?: Record<string, string | number>) => string} Translate */

/**
 * Texto de `key`, o `fallback` si esa clave no está traducida (una etapa o un código nuevo del servidor).
 * @param {Translate} t
 * @param {string} key
 * @param {string} fallback
 * @param {Record<string, string | number>} [params]
 */
export function textOr(t, key, fallback, params = {}) {
  const text = t(key, params);
  return text === key ? fallback : text;
}

/**
 * La frase que resume el estado de un trabajo.
 * @param {ReturnType<typeof import("../domain/job-state.js").trackingViewOf>} view
 * @param {Translate} t
 * @param {{ queued?: string, completed?: string }} [overrides] textos propios de un tipo de trabajo
 */
export function statusText(view, t, overrides = {}) {
  switch (view.kind) {
    case "queued":
      return overrides.queued ?? t("job.queued");
    case "running":
      return view.stage === null ? t("job.preparing") : t("job.running", { stage: textOr(t, `stage.${view.stage}`, view.stage), percent: view.percent });
    case "completed":
      return overrides.completed ?? t("job.completed");
    case "cancelled":
      return t("job.cancelled");
    case "failed":
      return textOr(t, `job.error.${view.failure?.code}`, t("job.error.INTERNAL"));
    case "lost":
      return view.error?.code === "not_found" ? t("job.lost.not_found") : t("job.lost");
    default:
      return "";
  }
}

/**
 * La línea de detalle: estado de la conexión mientras se espera, o el mensaje del servidor, o la causa de un fallo.
 * @param {ReturnType<typeof import("../domain/job-state.js").trackingViewOf>} view
 * @param {Translate} t
 */
export function detailText(view, t) {
  if (view.kind === "failed" && view.failure?.message) return t("error.detail", { detail: view.failure.message.slice(0, 300) });
  if (view.terminal || view.kind === "lost") return "";
  if (view.connection === "waiting") return t("job.conn.waiting", { seconds: view.waitSeconds });
  if (view.connection === "reconnecting") return t("job.conn.reconnecting");
  return view.message ?? "";
}
