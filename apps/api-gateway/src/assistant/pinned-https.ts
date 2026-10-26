// POST JSON a la IA propia de la persona con la IP fijada en la conexión (ADR 0022 / 0028): el DNS se resuelve UNA vez, se valida con
// `chooseAddress` y el socket se abre contra esa misma dirección; el nombre se conserva para SNI y certificado. Sin redirecciones, con
// tope de tiempo y de tamaño, y sin devolver nunca el cuerpo de un error del proveedor.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { type ChatRequest, chooseAddress } from "./chat.js";

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Error del transporte con un código estable (y el HTTP del proveedor si lo hubo): sirve para el log; nunca lleva el cuerpo. */
export class AiTransportError extends Error {
  constructor(
    message: string,
    readonly code: "https_only" | "http_status" | "not_json" | "too_large" | "cut_off" | "timeout",
    readonly status?: number,
  ) {
    super(message);
    this.name = code === "timeout" ? "AiTimeoutError" : "AiTransportError";
  }
}

export type ChatTransport = (request: ChatRequest) => Promise<unknown>;

export function createPinnedTransport(allowPrivate: boolean): ChatTransport {
  return (request) =>
    new Promise((resolve, reject) => {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
        reject(new AiTransportError("Solo se admite https.", "https_only"));
        return;
      }
      // Node no llama a `lookup` con una IP literal: se valida aquí también (la URL base ya las rechaza al guardar; esto es defensa en profundidad).
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) !== 0) {
        try {
          chooseAddress([{ address: literal, family: isIP(literal) === 6 ? 6 : 4 }], allowPrivate);
        } catch (blocked) {
          reject(blocked);
          return;
        }
      }
      const payload = JSON.stringify(request.body);
      const client = url.protocol === "https:" ? https : http;
      const lookup = (hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void): void => {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          try {
            const chosen = chooseAddress(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })), allowPrivate);
            if (options.all) callback(null, [chosen]);
            else callback(null, chosen.address, chosen.family);
          } catch (blocked) {
            callback(blocked);
          }
        });
      };
      const req = client.request(
        url,
        { method: "POST", headers: { ...request.headers, "Content-Length": Buffer.byteLength(payload) }, lookup: lookup as never, timeout: TIMEOUT_MS, agent: false },
        (response) => {
          const status = response.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new AiTransportError("Respuesta demasiado grande.", "too_large"));
              return;
            }
            chunks.push(chunk);
          });
          // Si el proveedor corta a mitad del cuerpo, `end` no llega: sin esto la promesa quedaría colgada hasta el tope del navegador.
          response.on("error", () => reject(new AiTransportError("La IA cortó la respuesta a medias.", "cut_off", status)));
          response.on("close", () => {
            if (!response.complete) reject(new AiTransportError("La IA cortó la respuesta a medias.", "cut_off", status));
          });
          response.on("end", () => {
            if (status < 200 || status >= 300) {
              reject(new AiTransportError(`La IA respondió HTTP ${status}.`, "http_status", status));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new AiTransportError("La IA devolvió algo que no es JSON.", "not_json", status));
            }
          });
        },
      );
      // `timeout` es de inactividad del socket; este plazo total corta también a quien suelta un byte cada tanto.
      const abort = () => req.destroy(new AiTransportError("La IA tardó demasiado en responder.", "timeout"));
      const overall = setTimeout(abort, TIMEOUT_MS);
      req.on("close", () => clearTimeout(overall));
      req.on("timeout", abort);
      req.on("error", reject);
      req.end(payload);
    });
}
