#!/usr/bin/env node
// Arranca el servidor MCP de CaptionForge por stdio. Variables: CAPTIONFORGE_URL (por defecto http://127.0.0.1:3000) y CAPTIONFORGE_API_KEY.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { createMcpServer } from "../src/server.mjs";

const apiKey = process.env.CAPTIONFORGE_API_KEY;
if (!apiKey) {
  process.stderr.write("Falta CAPTIONFORGE_API_KEY (créala en la página, en la sección de claves de API).\n");
  process.exit(1);
}
const server = createMcpServer({ baseUrl: process.env.CAPTIONFORGE_URL ?? "http://127.0.0.1:3000", apiKey, readFileImpl: readFile });

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } })}\n`);
    continue;
  }
  let response;
  try {
    response = await server.handle(message);
  } catch {
    response = { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Error interno" } };
  }
  if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
}
