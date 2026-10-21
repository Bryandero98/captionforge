// Segmentos de subtítulos: formato de segments.json, edición y SRT.
//
// redistributeWordTimings y segmentsToSrt reproducen a legacy/src/captionforge/srt.py. La paridad la
// garantizan los vectores de packages/contracts/examples/segments-golden.json, que ejecutan tanto
// las pruebas de este paquete como las de apps/ai-worker.

export interface WordTiming {
  start: number;
  end: number;
  text: string;
  probability: number | null;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: WordTiming[] | null;
}

export interface SegmentEdit {
  index: number;
  text?: string;
  start?: number;
  end?: number;
}

export class SegmentsError extends Error {}

export const MAX_SEGMENTS = 20_000;
const MAX_TEXT = 2_000;
const MAX_WORDS = 500;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Valida el contenido de un segments.json (lo escribe el worker, pero se relee con desconfianza). */
export function parseSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) throw new SegmentsError("segments.json debe ser una lista.");
  if (raw.length > MAX_SEGMENTS) throw new SegmentsError(`Hay demasiados segmentos (máximo ${MAX_SEGMENTS}).`);
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new SegmentsError(`El segmento ${index} no es un objeto.`);
    const { start, end, text, words } = item;
    if (!isNumber(start) || !isNumber(end) || typeof text !== "string") {
      throw new SegmentsError(`El segmento ${index} necesita start, end y text.`);
    }
    if (text.length > MAX_TEXT) throw new SegmentsError(`El texto del segmento ${index} es demasiado largo.`);
    if (words !== null && words !== undefined && !Array.isArray(words)) {
      throw new SegmentsError(`Los tiempos por palabra del segmento ${index} no son una lista.`);
    }
    const parsedWords = (words ?? null) === null ? null : parseWords(words as unknown[], index);
    return { start, end, text, words: parsedWords };
  });
}

function parseWords(words: unknown[], segmentIndex: number): WordTiming[] | null {
  if (words.length === 0) return null;
  if (words.length > MAX_WORDS) throw new SegmentsError(`El segmento ${segmentIndex} tiene demasiadas palabras.`);
  return words.map((word) => {
    if (!isRecord(word) || !isNumber(word.start) || !isNumber(word.end) || typeof word.text !== "string") {
      throw new SegmentsError(`Una palabra del segmento ${segmentIndex} no es válida.`);
    }
    const probability = word.probability;
    if (probability !== null && probability !== undefined && !isNumber(probability)) {
      throw new SegmentsError(`La probabilidad de una palabra del segmento ${segmentIndex} no es válida.`);
    }
    return { start: word.start, end: word.end, text: word.text, probability: probability ?? null };
  });
}

/** Valida el cuerpo de PUT /segments: { segments: [{ index, text?, start?, end? }], etag? }. */
export function parseEdits(body: unknown): { edits: SegmentEdit[]; etag: string | undefined } {
  if (!isRecord(body) || !Array.isArray(body.segments)) {
    throw new SegmentsError('El cuerpo debe ser { "segments": [ { "index": 0, "text": "..." } ] }.');
  }
  const unknown = Object.keys(body).filter((key) => key !== "segments" && key !== "etag");
  if (unknown.length > 0) throw new SegmentsError(`Campos desconocidos: ${unknown.join(", ")}.`);
  if (body.etag !== undefined && (typeof body.etag !== "string" || !/^[0-9a-f]{32}(-[0-9]+)?$/.test(body.etag))) {
    throw new SegmentsError("etag no es un ETag válido.");
  }
  if (body.segments.length > MAX_SEGMENTS) throw new SegmentsError("Demasiadas ediciones.");
  const seen = new Set<number>();
  const edits = body.segments.map((entry: unknown) => {
    const edit: Record<string, unknown> = isRecord(entry) ? entry : {};
    const { index, text, start, end } = edit;
    if (!Number.isInteger(index) || (index as number) < 0) {
      throw new SegmentsError("Cada edición necesita un 'index' entero (0 o más).");
    }
    if (seen.has(index as number)) throw new SegmentsError(`El segmento ${index} está repetido.`);
    seen.add(index as number);
    if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) {
      throw new SegmentsError(`El texto del segmento ${index} no es válido (máximo ${MAX_TEXT} caracteres).`);
    }
    for (const [name, value] of [["start", start], ["end", end]] as const) {
      if (value !== undefined && !isNumber(value)) throw new SegmentsError(`${name} del segmento ${index} no es un número.`);
    }
    return { index: index as number, text: text as string | undefined, start: start as number | undefined, end: end as number | undefined };
  });
  return { edits, etag: body.etag };
}

/**
 * Reparte el tramo [start, end) del segmento entre las palabras del texto nuevo, en proporción a su
 * longitud. Es una aproximación honesta (probability = null la marca como sintética), igual que en Python.
 */
export function redistributeWordTimings(text: string, start: number, end: number): WordTiming[] | null {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const duration = end - start;
  if (words.length === 0 || duration <= 0) return null;
  // Python cuenta puntos de código (len), JS unidades UTF-16: Array.from iguala el resultado con emojis.
  const weight = (word: string): number => Array.from(word).length;
  const total = words.reduce((sum, word) => sum + weight(word), 0);
  let cursor = start;
  const timings: WordTiming[] = words.map((word) => {
    const wordEnd = cursor + (weight(word) / total) * duration;
    const timing = { start: cursor, end: wordEnd, text: word, probability: null };
    cursor = wordEnd;
    return timing;
  });
  timings[timings.length - 1]!.end = end; // sin deriva de coma flotante en el último
  return timings;
}

/** Aplica las ediciones. Cambiar el texto reparte de nuevo los tiempos por palabra; cambiar solo los tiempos los conserva. */
export function applyEdits(segments: Segment[], edits: SegmentEdit[]): Segment[] {
  const byIndex = new Map(edits.map((edit) => [edit.index, edit]));
  for (const index of byIndex.keys()) {
    if (index >= segments.length) throw new SegmentsError(`El segmento ${index} no existe (hay ${segments.length}).`);
  }
  return segments.map((segment, index) => {
    const edit = byIndex.get(index);
    if (!edit) return segment;
    const start = edit.start ?? segment.start;
    const end = edit.end ?? segment.end;
    if (start < 0 || end <= start) {
      throw new SegmentsError(`Tiempos inválidos para el segmento ${index}: start=${start}, end=${end}.`);
    }
    const text = edit.text !== undefined ? edit.text.trim() : segment.text;
    const textChanged = edit.text !== undefined && text !== segment.text.trim();
    const words = textChanged ? redistributeWordTimings(text, start, end) : segment.words;
    return { start, end, text, words };
  });
}

/** Redondeo al par (como round() de Python): 0.5 -> 0, 1.5 -> 2. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function formatTimestamp(seconds: number): string {
  if (seconds < 0) throw new SegmentsError(`El tiempo no puede ser negativo: ${seconds}`);
  const totalMs = roundHalfEven(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(ms, 3)}`;
}

export function segmentsToSrt(segments: Segment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${segment.text.trim()}\n`,
    )
    .join("\n");
}
