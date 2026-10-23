import type { LoggerService } from "@nestjs/common";

type Level = "log" | "error" | "warn" | "debug" | "verbose" | "fatal";
const NAMES: Record<Level, string> = { log: "info", error: "error", warn: "warn", debug: "debug", verbose: "trace", fatal: "fatal" };

/**
 * Registro de Nest en JSON, una línea por evento (ADR 0018), para que Loki, CloudWatch o `jq` lo lean sin expresiones
 * regulares. Un mensaje que es un objeto se mezcla en la línea (así las peticiones llevan sus campos como claves).
 * JSON.stringify escapa saltos de línea y comillas: un valor controlado por el cliente no puede falsificar otra línea.
 */
export class JsonLogger implements LoggerService {
  private readonly write: (text: string) => void;

  constructor(options: { write?: (text: string) => void } = {}) {
    this.write = options.write ?? ((text) => void process.stdout.write(text));
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit("log", message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("verbose", message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit("fatal", message, params);
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    // Nest pasa el contexto como último argumento de texto; en error() el primero puede ser la traza.
    const context = typeof params.at(-1) === "string" ? (params.at(-1) as string) : undefined;
    const stack = level === "error" && params.length > 1 && typeof params[0] === "string" ? params[0] : undefined;
    const base: Record<string, unknown> = { time: new Date().toISOString(), level: NAMES[level], context };
    const body = typeof message === "object" && message !== null && !(message instanceof Error) ? (message as Record<string, unknown>) : { msg: message instanceof Error ? message.message : String(message) };
    const record = { ...base, ...body, ...(stack === undefined ? {} : { stack }) };
    this.write(`${JSON.stringify(record)}\n`);
  }
}
