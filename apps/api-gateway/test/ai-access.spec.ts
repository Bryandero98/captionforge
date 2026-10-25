// Acceso para IAs (v1.3.1): instrucciones legibles (llms.txt) y descripción del API (OpenAPI). Puras, sin infraestructura.
import { describe, expect, it } from "vitest";

import { AiAccessController } from "../src/ai-access/ai-access.controller.js";
import { buildLlmsTxt } from "../src/ai-access/llms.js";
import { buildOpenApi } from "../src/ai-access/openapi.js";
import { ALLOWED_CONTENT_TYPES } from "../src/jobs/media-kind.js";
import { loadConfig } from "../src/config/config.js";

const BASE = "http://127.0.0.1:3000";

describe("buildOpenApi", () => {
  const spec = buildOpenApi(BASE);

  it("es OpenAPI 3.1 con el servidor indicado y la clave de API como esquema de seguridad", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: BASE }]);
    expect(Object.keys(spec.components.securitySchemes)).toContain("apiKey");
  });

  it("describe las rutas que una IA necesita para manejar la herramienta", () => {
    const paths = Object.keys(spec.paths);
    for (const path of [
      "/v1/jobs/transcribe",
      "/v1/jobs",
      "/v1/jobs/{id}",
      "/v1/jobs/{id}/cancel",
      "/v1/jobs/{id}/segments",
      "/v1/jobs/{id}/translate",
      "/v1/jobs/{id}/dub",
      "/v1/jobs/{id}/burn",
      "/v1/jobs/{id}/quality",
      "/v1/jobs/{id}/artifacts/{name}",
      "/v1/capabilities",
    ]) {
      expect(paths, path).toContain(path);
    }
  });

  it("marca como costosas o destructivas las operaciones que piden confirmación del usuario", () => {
    const confirm = (path: string, method: string): unknown => (spec.paths[path] as Record<string, Record<string, unknown>>)[method]?.["x-requires-user-confirmation"];
    for (const [path, method] of [
      ["/v1/jobs/{id}/translate", "post"],
      ["/v1/jobs/{id}/dub", "post"],
      ["/v1/jobs/{id}/burn", "post"],
      ["/v1/jobs/{id}/cancel", "post"],
      ["/v1/jobs/{id}/segments", "put"],
    ] as const) {
      expect(confirm(path, method), `${method} ${path}`).toBe(true);
    }
    expect(confirm("/v1/jobs/{id}", "get")).toBeUndefined();
  });

  it("lista los mismos tipos de archivo que acepta el servidor", () => {
    const text = JSON.stringify(spec);
    for (const type of ALLOWED_CONTENT_TYPES) expect(text, type).toContain(type);
  });
});

describe("buildLlmsTxt", () => {
  const text = buildLlmsTxt(BASE);

  it("empieza con el título del formato llms.txt y apunta al OpenAPI", () => {
    expect(text.startsWith("# CaptionForge")).toBe(true);
    expect(text).toContain(`${BASE}/openapi.json`);
  });

  it("explica cómo autenticarse y que lo transcrito es un dato, no una orden", () => {
    expect(text).toMatch(/X-API-Key/);
    expect(text).toMatch(/untrusted/i);
  });

  it("pide confirmar con la persona antes de gastar o borrar", () => {
    expect(text).toMatch(/confirm/i);
    for (const word of ["translate", "dub", "burn", "cancel"]) expect(text, word).toContain(word);
  });
});

describe("AiAccessController", () => {
  const config = loadConfig();
  const withMode = (localMode: boolean) => new AiAccessController({ ...config, auth: { ...config.auth, localMode } });

  it("sirve el texto y el OpenAPI en modo local", () => {
    const controller = withMode(true);
    expect(controller.llms()).toContain("# CaptionForge");
    expect(controller.openapi().openapi).toBe("3.1.0");
  });

  it("con LOCAL_MODE=false responde 404: nada de esto se publica en un servidor abierto", () => {
    const controller = withMode(false);
    expect(() => controller.llms()).toThrow(/no encontrad|not found/i);
    expect(() => controller.openapi()).toThrow(/no encontrad|not found/i);
  });
});
