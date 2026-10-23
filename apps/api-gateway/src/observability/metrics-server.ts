import http from "node:http";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { MetricsService } from "./metrics.service.js";

/**
 * Servidor de métricas en un puerto APARTE del API (ADR 0018). El puerto público no sirve `/metrics`: Prometheus lo lee por la
 * red interna de Docker (`api-gateway:9090`), que no se publica en el host, y Caddy además responde 404 a esa ruta. Así, que
 * alguien configure mal el proxy no expone las métricas.
 */
export function startMetricsServer(app: NestFastifyApplication, { host, port }: { host: string; port: number }): Promise<http.Server> {
  const metrics = app.get(MetricsService);
  const server = http.createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain" }).end("no encontrado\n");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "content-type": "text/plain" }).end("método no permitido\n");
      return;
    }
    metrics
      .render()
      .then((body) => response.writeHead(200, { "content-type": metrics.registry.contentType, "cache-control": "no-store" }).end(body))
      .catch(() => response.writeHead(500, { "content-type": "text/plain" }).end("error al leer las métricas\n"));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
