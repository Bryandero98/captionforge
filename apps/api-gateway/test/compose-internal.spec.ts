// El canal interno del worker (ADR 0020) vive en un puerto que NO se publica: solo la red de Docker lo alcanza. Se comprueba sobre el
// docker-compose.yml real, para que un `ports:` añadido por descuido rompa la prueba y no quede expuesto en el anfitrión.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const compose = readFileSync(resolve(import.meta.dirname, "../../../docker-compose.yml"), "utf8").replaceAll("\r\n", "\n");

/** Texto de un servicio: desde `  nombre:` hasta el siguiente servicio (dos espacios de sangría) o la siguiente clave de primer nivel. */
function service(name: string): string {
  const match = new RegExp(String.raw`^  ${name}:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|^[A-Za-z])`, "m").exec(compose);
  if (match === null) throw new Error(`No se encontró el servicio ${name} en docker-compose.yml`);
  return match[1]!;
}

/** Entradas de `ports:` de un servicio. */
function ports(block: string): string[] {
  const match = /^ {4}ports:\n((?: {6}- .*\n?)+)/m.exec(block);
  return match === null ? [] : match[1]!.split("\n").filter((line) => line.trim() !== "").map((line) => line.trim().replace(/^- /, ""));
}

describe("docker-compose.yml: canal interno del worker", () => {
  it("el API define el puerto interno y NO lo publica en el anfitrión", () => {
    const api = service("api-gateway");
    expect(api).toMatch(/INTERNAL_PORT: .*3100/);
    expect(ports(api).join(" ")).not.toMatch(/3100|INTERNAL_PORT/);
    // Solo se publica el puerto público, y en el loopback.
    expect(ports(api)).toEqual(['"127.0.0.1:${CF_PORT:-3000}:3000"']);
  });

  it("ningún servicio publica el puerto interno", () => {
    expect(compose).not.toMatch(/-\s*"?[\d.:]*3100:\d+"?/);
    expect(compose).not.toMatch(/-\s*"?[\d.:]*\d+:3100"?/);
    expect(compose).not.toMatch(/expose:[\s\S]{0,40}3100/); // ni siquiera lo anuncia a otras redes
  });

  it("el worker llega al API por la red interna", () => {
    const worker = service("ai-worker");
    expect(worker).toMatch(/API_INTERNAL_URL: http:\/\/api-gateway:3100/);
    expect(worker).toMatch(/WORKER_INTERNAL_TOKEN: /);
  });

  it("APP_SECRET lo recibe solo el API: el worker nunca ve el secreto que descifra las claves", () => {
    expect(service("api-gateway")).toMatch(/APP_SECRET: /);
    expect(service("ai-worker")).not.toMatch(/APP_SECRET/);
  });

  it("Caddy no enruta nada al puerto interno", () => {
    const caddyfile = readFileSync(resolve(import.meta.dirname, "../../../docker/caddy/Caddyfile"), "utf8");
    const code = caddyfile.replace(/#.*$/gm, ""); // los comentarios pueden nombrar el puerto; las directivas no
    expect(code).not.toMatch(/3100/);
    expect(code).toMatch(/@internal path \/internal \/internal\/\*\s+handle @internal \{\s+respond 404/); // si alguien lo apuntara aquí, 404
  });
});
