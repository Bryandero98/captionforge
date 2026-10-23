// Errores del API como valores con código estable: la interfaz decide el texto por `code`, nunca por el
// mensaje del servidor (que viene en español y puede cambiar). El `detail` del servidor se muestra solo como apoyo.

/** @typedef {"invalid_request"|"unauthorized"|"forbidden"|"role_forbidden"|"gone"|"not_found"|"too_slow"|"conflict"|"last_owner"|"invite_limit"|"last_membership"|"invalid_key_format"|"same_language"|"byok_disabled"|"external_key_missing"|"job_too_large"|"too_large"|"unsupported_type"|"misdirected"|"rate_limited"|"busy"|"server"|"network"|"timeout"|"aborted"|"bad_response"|"unexpected"} ErrorCode */

/** @type {Record<number, ErrorCode>} */
const CODE_BY_STATUS = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  408: "too_slow",
  409: "conflict",
  410: "gone",
  413: "too_large",
  415: "unsupported_type",
  421: "misdirected",
  429: "rate_limited",
  503: "busy",
};

/** Lo que tiene sentido volver a intentar tal cual: saturación pasajera, fallo del servidor o de la red. */
const RETRYABLE = new Set(["rate_limited", "busy", "server", "network", "timeout", "aborted"]);

/** `code` estable de un 409 del API (ADR 0019): distingue «último Dueño» de «tope de invitaciones» y de «único espacio». */
const CONFLICT_CODES = new Set(["last_owner", "invite_limit", "last_membership"]);

/**
 * `code` estable de un 400/404/409/413 de claves externas, traducir y doblar (ADR 0020): cada uno vale solo con los estados que el API le da,
 * así un cuerpo raro en un 500 no se hace pasar por un error del usuario.
 * @type {Record<string, readonly number[]>}
 */
const BODY_CODE_STATUSES = {
  invalid_key_format: [400],
  same_language: [400],
  byok_disabled: [404, 409],
  external_key_missing: [409],
  job_too_large: [413],
};

const MAX_DETAIL = 300;
const MAX_RETRY_AFTER_SECONDS = 300;

export class ApiError extends Error {
  /**
   * @param {{ status?: number, code: ErrorCode, detail?: string | null, retryAfter?: number | null }} fields
   */
  constructor({ status = 0, code, detail = null, retryAfter = null }) {
    super(detail ?? code);
    this.name = code === "aborted" ? "AbortError" : "ApiError";
    /** Estado HTTP, o 0 si no hubo respuesta (red, aborto) o el error es local. */
    this.status = status;
    /** @type {ErrorCode} */
    this.code = code;
    /** Texto del servidor, recortado: solo como apoyo. */
    this.detail = detail;
    /** Segundos que pidió esperar el servidor (Retry-After), o null. */
    this.retryAfter = retryAfter;
    this.retryable = RETRYABLE.has(code);
  }

  /** No hubo respuesta: puede ser un corte de red o un rechazo temprano con un cuerpo enorme (el API solo descarta 16 MiB), así que es ambiguo. */
  static network() {
    return new ApiError({ code: "network" });
  }

  static timeout() {
    return new ApiError({ code: "timeout" });
  }

  /** La persona canceló: no es un fallo. */
  static aborted() {
    return new ApiError({ code: "aborted" });
  }

  /** Error detectado en el cliente, sin tocar la red. */
  static local(/** @type {ErrorCode} */ code, /** @type {string | null} */ detail = null) {
    return new ApiError({ code, detail });
  }
}

/** Segundos de un Retry-After numérico; las fechas HTTP y lo raro se ignoran, y hay un techo. */
export function parseRetryAfter(/** @type {unknown} */ value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  return Math.min(Number(value.trim()), MAX_RETRY_AFTER_SECONDS);
}

/** `message` del formato de error de Nest: texto o lista de textos. */
function detailOf(/** @type {unknown} */ body) {
  if (body === null || typeof body !== "object") return null;
  const message = /** @type {{ message?: unknown }} */ (body).message;
  const text = Array.isArray(message) ? message.filter((part) => typeof part === "string").join("; ") : message;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text.trim().slice(0, MAX_DETAIL);
}

/**
 * Error a partir de una respuesta HTTP que no es un éxito.
 * @param {number} status
 * @param {string} bodyText
 * @param {string | null} retryAfterHeader
 */
export function errorFromResponse(status, bodyText, retryAfterHeader) {
  /** @type {unknown} */
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // Una página de error de un proxy no es JSON: el código sale del estado.
  }
  // Un 403 con `code: role_forbidden` es el rol (ADR 0019); cualquier otro 403 sigue siendo «esta página no está autorizada».
  const roleDenied = status === 403 && body !== null && typeof body === "object" && /** @type {{ code?: unknown }} */ (body).code === "role_forbidden";
  const bodyCode = body !== null && typeof body === "object" ? /** @type {{ code?: unknown }} */ (body).code : undefined;
  const conflictCode = status === 409 && typeof bodyCode === "string" && CONFLICT_CODES.has(bodyCode) ? /** @type {ErrorCode} */ (bodyCode) : null;
  const externalCode = typeof bodyCode === "string" && BODY_CODE_STATUSES[bodyCode]?.includes(status) ? /** @type {ErrorCode} */ (bodyCode) : null;
  const code = roleDenied ? "role_forbidden" : (conflictCode ?? externalCode ?? CODE_BY_STATUS[status] ?? (status >= 500 ? "server" : "unexpected"));
  return new ApiError({ status, code, detail: detailOf(body), retryAfter: parseRetryAfter(retryAfterHeader) });
}
