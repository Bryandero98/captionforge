// Formato de tamaños y duraciones para la barra de subida. Funciones puras.

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Tamaño en unidades de 1024 con un decimal como máximo; los valores inválidos caen en «0 B». */
export function formatBytes(/** @type {number} */ bytes, /** @type {string} */ lang) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const index = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  const number = new Intl.NumberFormat(lang === "es" ? "es" : "en", { maximumFractionDigits: index === 0 ? 0 : 1 }).format(value);
  return `${number} ${UNITS[index]}`;
}

/** «1 min 20 s», «45 s», «1 h 2 min»; cadena vacía si no hay una estimación que mostrar. */
export function formatDuration(/** @type {number | null | undefined} */ seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.ceil(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}
