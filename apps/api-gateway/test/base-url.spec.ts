// URL base propia de un proveedor de IA (ADR 0022): lo único que decide a qué servidor viaja la clave del espacio.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isPublicAddress, parseBaseUrl } from "../src/external-keys/base-url.js";

describe("parseBaseUrl: lo que se acepta", () => {
  it("una URL https pública se normaliza: host en minúsculas y sin barra final", () => {
    expect(parseBaseUrl("https://API.DeepSeek.com/")).toEqual({ url: "https://api.deepseek.com", host: "api.deepseek.com" });
    expect(parseBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/")).toEqual({
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
      host: "generativelanguage.googleapis.com",
    });
    expect(parseBaseUrl("  https://routellm.abacus.ai/v1  ")?.url).toBe("https://routellm.abacus.ai/v1");
  });

  it("acepta un puerto explícito", () => {
    expect(parseBaseUrl("https://llm.example.com:8443/v1")).toEqual({ url: "https://llm.example.com:8443/v1", host: "llm.example.com:8443" });
  });

  it("convierte nombres internacionales a punycode (no se puede disfrazar el host)", () => {
    expect(parseBaseUrl("https://bücher.example/v1")?.host).toBe("xn--bcher-kva.example");
  });
});

describe("parseBaseUrl: lo que se rechaza", () => {
  const rejected: [string, string][] = [
    ["http sin cifrar", "http://api.deepseek.com"],
    ["otros esquemas", "ftp://api.deepseek.com"],
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["usuario y contraseña en la URL", "https://user:pass@api.deepseek.com"],
    ["solo usuario", "https://user@api.deepseek.com"],
    ["consulta", "https://api.deepseek.com/v1?key=x"],
    ["fragmento", "https://api.deepseek.com/v1#x"],
    ["ruta con ..", "https://api.deepseek.com/v1/../admin"],
    ["ruta con %2e%2e", "https://api.deepseek.com/v1/%2e%2e/admin"],
    ["ruta con barra invertida", "https://api.deepseek.com/v1\\admin"],
    ["bucle IPv4", "https://127.0.0.1/v1"],
    ["bucle IPv4 en decimal", "https://2130706433/v1"],
    ["bucle IPv4 en hexadecimal", "https://0x7f000001/v1"],
    ["bucle IPv4 abreviado", "https://127.1/v1"],
    ["red privada 10", "https://10.0.0.5/v1"],
    ["red privada 172.16", "https://172.16.0.1/v1"],
    ["red privada 192.168", "https://192.168.1.10/v1"],
    ["metadatos de nube", "https://169.254.169.254/latest/meta-data"],
    ["CGNAT", "https://100.64.0.1/v1"],
    ["una IP pública literal (solo se aceptan nombres)", "https://8.8.8.8/v1"],
    ["IPv6 de bucle", "https://[::1]/v1"],
    ["IPv6 local única", "https://[fd00::1]/v1"],
    ["IPv4 mapeada en IPv6", "https://[::ffff:127.0.0.1]/v1"],
    ["localhost", "https://localhost/v1"],
    ["localhost con punto final", "https://localhost./v1"],
    ["subdominio de localhost", "https://api.localhost/v1"],
    ["nombre .local", "https://nas.local/v1"],
    ["nombre .internal", "https://llm.internal/v1"],
    ["nombre .lan", "https://llm.lan/v1"],
    ["nombre sin punto", "https://intranet/v1"],
    ["vacío", ""],
    ["solo espacios", "   "],
    ["no es una URL", "api.deepseek.com"],
  ];
  for (const [name, value] of rejected) {
    it(`rechaza: ${name}`, () => {
      expect(parseBaseUrl(value)).toBeUndefined();
    });
  }

  it("rechaza lo que no es texto y las URL demasiado largas", () => {
    for (const bad of [undefined, null, 5, {}, [], true]) expect(parseBaseUrl(bad)).toBeUndefined();
    expect(parseBaseUrl(`https://api.deepseek.com/${"a".repeat(2100)}`)).toBeUndefined();
  });

  it("rechaza caracteres de control y espacios dentro", () => {
    expect(parseBaseUrl("https://api.deepseek.com/v1\n")?.url).toBe("https://api.deepseek.com/v1"); // el salto de línea final es un error de pegado
    expect(parseBaseUrl("https://api.deep seek.com/v1")).toBeUndefined();
    expect(parseBaseUrl("https://api.deepseek.com/v\u00001")).toBeUndefined();
  });
});

describe("isPublicAddress", () => {
  it("separa direcciones públicas de privadas, de bucle, enlace local, metadatos y reservadas", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "142.250.80.46", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicAddress(address)).toBe(true);
    for (const address of [
      "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.5.5", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.255.255",
      "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2001:db8::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("lo que no es una dirección no cuenta como pública", () => {
    for (const bad of ["", "abc", "999.1.1.1", "1.2.3", "1.2.3.4.5", "::g"]) expect(isPublicAddress(bad)).toBe(false);
  });

  it("propiedad: ninguna IPv4 de los rangos privados o reservados se considera pública", () => {
    const octet = fc.integer({ min: 0, max: 255 });
    const privateV4 = fc.oneof(
      fc.tuple(fc.constant(10), octet, octet, octet),
      fc.tuple(fc.constant(127), octet, octet, octet),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
      fc.tuple(fc.constant(192), fc.constant(168), octet, octet),
      fc.tuple(fc.constant(169), fc.constant(254), octet, octet),
      fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), octet, octet),
      fc.tuple(fc.integer({ min: 224, max: 255 }), octet, octet, octet),
    );
    fc.assert(
      fc.property(privateV4, (parts) => {
        const address = parts.join(".");
        expect(isPublicAddress(address)).toBe(false);
        expect(isPublicAddress(`::ffff:${address}`)).toBe(false);
        expect(parseBaseUrl(`https://${address}/v1`)).toBeUndefined();
      }),
    );
  });

  it("propiedad: parseBaseUrl nunca acepta un host que sea una IP", () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.ipV6(), (v4, v6) => {
        expect(parseBaseUrl(`https://${v4}/v1`)).toBeUndefined();
        expect(parseBaseUrl(`https://[${v6}]/v1`)).toBeUndefined();
      }),
    );
  });
});
