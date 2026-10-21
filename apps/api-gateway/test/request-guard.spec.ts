import { describe, expect, it } from "vitest";

import { describePolicy, evaluate, hostnameOf, type RequestInfo } from "../src/security/request-guard.js";

const policy = { allowedOrigins: ["http://localhost:5173"], allowedHosts: ["localhost", "127.0.0.1", "[::1]"] };
const request = (overrides: Partial<RequestInfo> = {}): RequestInfo => ({
  method: "POST",
  path: "/v1/jobs/transcribe",
  host: "127.0.0.1:3000",
  origin: undefined,
  secFetchSite: undefined,
  ...overrides,
});

describe("hostnameOf", () => {
  it.each([
    ["localhost:3000", "localhost"],
    ["LOCALHOST", "localhost"],
    ["127.0.0.1:80", "127.0.0.1"],
    ["[::1]:3000", "[::1]"],
    ["[::1]", "[::1]"],
    ["api.ejemplo.com:8443", "api.ejemplo.com"],
  ])("%s -> %s", (header, expected) => expect(hostnameOf(header)).toBe(expected));

  it.each([undefined, "", " ", "a b", "evil.com@localhost", "localhost/ruta", "localhost:abc", "[::1", "localhost.", "a,b"])(
    "rechaza %j (cabecera Host malformada)",
    (header) => expect(hostnameOf(header as string | undefined)).toBeUndefined(),
  );
});

describe("evaluate: Host (anti DNS rebinding)", () => {
  it.each(["127.0.0.1:3000", "localhost:3000", "LOCALHOST", "[::1]:3000"])("deja pasar el Host permitido %s", (host) =>
    expect(evaluate(request({ host }), policy)).toBeNull(),
  );

  it.each(["evil.example", "evil.example:3000", "127.0.0.1.evil.example", "localhost.evil.example", "10.0.0.5:3000", undefined, "", "a b"])(
    "421 con el Host no permitido %j",
    (host) => expect(evaluate(request({ host }), policy)).toMatchObject({ status: 421 }),
  );

  it("/health queda exento para los sondeos del orquestador (GET o HEAD sin Origin, con cualquier Host)", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(evaluate(request({ method, path: "/health", host: "10.0.0.5:3000" }), policy), method).toBeNull();
    }
    expect(evaluate(request({ method: "GET", path: "/health?x=1", host: "10.0.0.5:3000" }), policy)).toBeNull();
    expect(evaluate(request({ method: "GET", path: "/health", host: "10.0.0.5:3000", secFetchSite: "none" }), policy)).toBeNull();
  });

  it("/health NO queda exento para el navegador: un sondeo no lleva Origin ni Sec-Fetch-Site de otro sitio", () => {
    // <img src="http://127.0.0.1:3000/health"> desde una página ajena: cada petición ejecuta SELECT 1 y pings a Redis y S3.
    expect(evaluate(request({ method: "GET", path: "/health", secFetchSite: "cross-site" }), policy)).toMatchObject({ status: 403 });
    expect(evaluate(request({ method: "GET", path: "/health", secFetchSite: "same-site" }), policy)).toMatchObject({ status: 403 });
    expect(evaluate(request({ method: "GET", path: "/health", origin: "http://evil.example" }), policy)).toMatchObject({ status: 403 });
    // Con DNS rebinding el Host es el del atacante: también 421.
    expect(evaluate(request({ method: "GET", path: "/health", host: "evil.example", origin: "http://evil.example" }), policy)).toMatchObject({ status: 421 });
  });

  it("el cliente web autorizado sí puede consultar /health (Origin permitido)", () => {
    expect(evaluate(request({ method: "GET", path: "/health", origin: "http://localhost:5173", secFetchSite: "same-site" }), policy)).toBeNull();
  });
});

describe("evaluate: Origin (CSRF)", () => {
  it("sin Origin (curl, servidores) pasa: no hay navegador que engañar", () => {
    expect(evaluate(request(), policy)).toBeNull();
  });

  it("403 con un Origin que no está en la lista, en cualquier método", () => {
    for (const method of ["POST", "PUT", "GET", "OPTIONS", "DELETE"]) {
      expect(evaluate(request({ method, origin: "http://evil.example" }), policy), method).toMatchObject({ status: 403 });
    }
  });

  it.each(["null", "file://", "not a url", "ftp://localhost", "http://localhost:5173.evil.example", "http://localhost:5174", "https://localhost:5173"])(
    "403 con el Origin %j (no coincide exactamente)",
    (origin) => expect(evaluate(request({ origin }), policy)).toMatchObject({ status: 403 }),
  );

  it("deja pasar un Origin de la lista (comparación exacta, sin distinguir mayúsculas del esquema/host)", () => {
    expect(evaluate(request({ origin: "http://localhost:5173" }), policy)).toBeNull();
    expect(evaluate(request({ origin: "HTTP://LOCALHOST:5173" }), policy)).toBeNull();
  });

  it("deja pasar el mismo origen (Origin igual al Host de la petición)", () => {
    expect(evaluate(request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), policy)).toBeNull();
  });

  it("la lista vacía no permite ningún origen ajeno (fail-closed)", () => {
    expect(evaluate(request({ origin: "http://localhost:5173" }), { ...policy, allowedOrigins: [] })).toMatchObject({ status: 403 });
  });
});

describe("evaluate: Sec-Fetch-Site", () => {
  it("403 a una petición que modifica y viene de otro sitio aunque no traiga Origin", () => {
    for (const secFetchSite of ["cross-site", "same-site"]) {
      expect(evaluate(request({ secFetchSite }), policy), secFetchSite).toMatchObject({ status: 403 });
    }
  });

  it("las lecturas (GET, HEAD) de otro sitio no se bloquean por esta señal: enlaces de descarga y navegación", () => {
    expect(evaluate(request({ method: "GET", secFetchSite: "cross-site" }), policy)).toBeNull();
    expect(evaluate(request({ method: "HEAD", secFetchSite: "cross-site" }), policy)).toBeNull();
  });

  it("mismo origen, ninguno o navegación directa pasan", () => {
    for (const secFetchSite of ["same-origin", "none", undefined]) {
      expect(evaluate(request({ secFetchSite }), policy), String(secFetchSite)).toBeNull();
    }
  });

  it("un origen permitido pasa aunque sea cross-site (el cliente web en otro puerto o dominio)", () => {
    expect(evaluate(request({ origin: "http://localhost:5173", secFetchSite: "same-site" }), policy)).toBeNull();
    expect(evaluate(request({ origin: "http://localhost:5173", secFetchSite: "cross-site" }), policy)).toBeNull();
  });
});

describe("describePolicy", () => {
  it("resume en una línea qué hosts y orígenes se aceptan, para el registro de arranque", () => {
    expect(describePolicy(policy)).toBe("hosts: localhost, 127.0.0.1, [::1]; orígenes de navegador: http://localhost:5173");
    expect(describePolicy({ allowedHosts: ["localhost"], allowedOrigins: [] })).toBe("hosts: localhost; orígenes de navegador: ninguno (solo mismo origen)");
  });
});
