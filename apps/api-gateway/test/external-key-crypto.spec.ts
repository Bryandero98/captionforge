// Cifrado de las claves externas (ADR 0020): AES-256-GCM con la clave derivada de APP_SECRET por HKDF-SHA256 y el AAD
// `tenantId|provider|keyVersion`. Pruebas sin infraestructura: solo criptografía.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ExternalKeyCipher, ExternalKeyDecryptError, keyHint } from "../src/external-keys/external-key-crypto.js";

const SECRET = "s".repeat(16) + "ecreto-de-prueba-de-32-bytes!!!";
const PLAIN = "sk-canario-1234567890abcdefghijklmnopqrstuvwxyz";
const context = () => ({ tenantId: randomUUID(), provider: "openai" as const, keyVersion: 1 });

const swapPart = (stored: string, index: number): string => {
  const parts = stored.split(".");
  const part = parts[index] ?? "";
  // Cambia un carácter del trozo por otro distinto del alfabeto base64url.
  parts[index] = (part.startsWith("A") ? "B" : "A") + part.slice(1);
  return parts.join(".");
};

describe("ExternalKeyCipher", () => {
  it("descifra lo que cifró con el mismo contexto", () => {
    const cipher = new ExternalKeyCipher(SECRET);
    const ctx = context();
    expect(cipher.decrypt(cipher.encrypt(PLAIN, ctx), ctx)).toBe(PLAIN);
  });

  it("guarda `v1.<iv>.<etiqueta>.<datos>` y nada del texto original", () => {
    const stored = new ExternalKeyCipher(SECRET).encrypt(PLAIN, context());
    const parts = stored.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1]!, "base64url")).toHaveLength(12); // IV de 96 bits
    expect(Buffer.from(parts[2]!, "base64url")).toHaveLength(16); // etiqueta de 128 bits
    expect(stored).not.toContain(PLAIN);
    expect(stored).not.toContain(PLAIN.slice(3, 20));
    expect(Buffer.from(parts[3]!, "base64url").toString("utf8")).not.toContain("canario");
  });

  it("no repite el IV ni el resultado en 10 000 cifrados del mismo texto", () => {
    const cipher = new ExternalKeyCipher(SECRET);
    const ctx = context();
    const ivs = new Set<string>();
    const results = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const stored = cipher.encrypt(PLAIN, ctx);
      ivs.add(stored.split(".")[1]!);
      results.add(stored);
    }
    expect(ivs.size).toBe(10_000);
    expect(results.size).toBe(10_000);
  });

  it.each([
    ["el IV", 1],
    ["la etiqueta de autenticación", 2],
    ["los datos cifrados", 3],
  ])("rechaza el texto cifrado si se altera %s", (_name, index) => {
    const cipher = new ExternalKeyCipher(SECRET);
    const ctx = context();
    const stored = cipher.encrypt(PLAIN, ctx);
    expect(() => cipher.decrypt(swapPart(stored, index), ctx)).toThrow(ExternalKeyDecryptError);
  });

  it("no descifra con otro espacio de trabajo, otro proveedor u otra versión (AAD)", () => {
    const cipher = new ExternalKeyCipher(SECRET);
    const ctx = context();
    const stored = cipher.encrypt(PLAIN, ctx);
    expect(() => cipher.decrypt(stored, { ...ctx, tenantId: randomUUID() })).toThrow(ExternalKeyDecryptError);
    expect(() => cipher.decrypt(stored, { ...ctx, provider: "elevenlabs" })).toThrow(ExternalKeyDecryptError);
    expect(() => cipher.decrypt(stored, { ...ctx, keyVersion: 2 })).toThrow(ExternalKeyDecryptError);
  });

  it("no descifra con otro APP_SECRET", () => {
    const ctx = context();
    const stored = new ExternalKeyCipher(SECRET).encrypt(PLAIN, ctx);
    expect(() => new ExternalKeyCipher(SECRET + "x").decrypt(stored, ctx)).toThrow(ExternalKeyDecryptError);
  });

  it.each([
    ["vacío", ""],
    ["sin separadores", "v1"],
    ["versión desconocida", "v9.AAAA.BBBB.CCCC"],
    ["faltan trozos", "v1.AAAA.BBBB"],
    ["sobran trozos", "v1.AAAA.BBBB.CCCC.DDDD"],
    ["IV de tamaño incorrecto", "v1.AAAA.AAAAAAAAAAAAAAAAAAAAAA.CCCC"],
  ])("rechaza un valor guardado mal formado: %s", (_name, stored) => {
    expect(() => new ExternalKeyCipher(SECRET).decrypt(stored, context())).toThrow(ExternalKeyDecryptError);
  });

  it("los errores no contienen el texto en claro ni el APP_SECRET", () => {
    const cipher = new ExternalKeyCipher(SECRET);
    const ctx = context();
    const stored = cipher.encrypt(PLAIN, ctx);
    let message = "";
    try {
      cipher.decrypt(stored, { ...ctx, tenantId: randomUUID() });
    } catch (error) {
      message = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(PLAIN);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(stored);
  });

  it("exige un APP_SECRET de al menos 32 bytes", () => {
    expect(() => new ExternalKeyCipher("corto")).toThrow(/APP_SECRET/);
    expect(() => new ExternalKeyCipher("x".repeat(31))).toThrow(/APP_SECRET/);
    expect(() => new ExternalKeyCipher("x".repeat(32))).not.toThrow();
  });

  it("no cifra un texto vacío", () => {
    expect(() => new ExternalKeyCipher(SECRET).encrypt("", context())).toThrow();
  });
});

describe("keyHint", () => {
  it("devuelve solo los últimos 4 caracteres", () => {
    expect(keyHint("sk-canario-1234567890abcdefghij")).toBe("ghij");
  });

  it("no revela una clave corta entera", () => {
    expect(keyHint("abcdef")).toBe("");
  });
});
