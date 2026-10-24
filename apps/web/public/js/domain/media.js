// Audio o video (Issue #14, audio universal): lo que la interfaz ofrece según la clase del archivo. El servidor es quien manda
// (`mediaKind` del trabajo, y rechaza el quemado y la mezcla sobre audio); esto solo evita ofrecer lo que no va a funcionar.

/** Tipos MIME de audio que acepta el servidor, con los nombres que mandan los distintos navegadores. */
export const AUDIO_MIME_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
]);

export const AUDIO_EXTENSIONS = Object.freeze(["mp3", "wav", "m4a", "ogg", "flac"]);

const AUDIO_MIME_SET = new Set(AUDIO_MIME_TYPES);

/** @param {unknown} type */
export const isAudioMime = (type) => typeof type === "string" && AUDIO_MIME_SET.has(type);

/** ¿Es un trabajo de audio puro? Sin dato (servidor antiguo) cuenta como video: nada se oculta por error. @param {unknown} job */
export const isAudioJob = (job) => job !== null && typeof job === "object" && /** @type {{ mediaKind?: unknown }} */ (job).mediaKind === "audio";

/** Los subtítulos solo se queman sobre imagen. @param {unknown} job */
export const canBurn = (job) => !isAudioJob(job);

/** Salidas del doblaje: un audio solo puede ser la pista de voz; un video también se mezcla en la imagen. @param {unknown} job @returns {("none" | "replace" | "duck")[]} */
export const DUB_MIXES_FOR = (job) => (isAudioJob(job) ? ["none"] : ["none", "replace", "duck"]);
