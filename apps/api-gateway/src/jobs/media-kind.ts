// Qué archivos acepta el servidor y de qué clase son (Issue #14, audio universal). Video como siempre y audio puro:
// MP3, WAV, M4A, OGG y FLAC, con los nombres de tipo que mandan los distintos navegadores. Debe coincidir con el enum de
// `contentType` de `transcribe-job.v1.json` (el contrato rechaza lo demás) y con la lista del cliente (`web/js/api/upload.js`).

export const VIDEO_CONTENT_TYPES = ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm", "video/x-msvideo"] as const;

export const AUDIO_CONTENT_TYPES = [
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
] as const;

export const ALLOWED_CONTENT_TYPES = [...VIDEO_CONTENT_TYPES, ...AUDIO_CONTENT_TYPES] as const;

export type MediaKind = "audio" | "video";

/** Clase de un archivo según el tipo guardado. Lo desconocido cuenta como video: los trabajos anteriores al audio no tienen otra cosa. */
export function mediaKindOf(contentType: string | null | undefined): MediaKind {
  return (AUDIO_CONTENT_TYPES as readonly string[]).includes(contentType ?? "") ? "audio" : "video";
}
