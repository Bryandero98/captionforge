export const QUEUES = {
  transcribe: "captionforge.transcribe",
  burn: "captionforge.burn",
  translate: "captionforge.translate",
  dub: "captionforge.dub",
} as const;

/** Canal de Redis por el que el API pide al worker que aborte un trabajo en curso. */
export const CANCEL_CHANNEL = "captionforge:cancel";
