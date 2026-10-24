import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_HOST: "redis",
  REDIS_PASSWORD: "secreto",
  S3_ENDPOINT: "http://s3:9000",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
};

describe("loadConfig", () => {
  describe("DIARIZATION_ENABLED (identificar quién habla)", () => {
    it("apagada por defecto", () => {
      expect(loadConfig(base).features.diarization).toBe(false);
    });

    it("la enciende el valor explícito true/1 y la apaga false/0, también con HF_TOKEN presente", () => {
      expect(loadConfig({ ...base, DIARIZATION_ENABLED: "true" }).features.diarization).toBe(true);
      expect(loadConfig({ ...base, DIARIZATION_ENABLED: "1" }).features.diarization).toBe(true);
      expect(loadConfig({ ...base, DIARIZATION_ENABLED: "false", HF_TOKEN: "hf_" + "x".repeat(30) }).features.diarization).toBe(false);
      expect(loadConfig({ ...base, DIARIZATION_ENABLED: "0" }).features.diarization).toBe(false);
    });

    it("sin valor explícito se deduce de que haya token (HF_TOKEN o HF_TOKEN_FILE) en el entorno del servicio", () => {
      expect(loadConfig({ ...base, HF_TOKEN: "hf_" + "x".repeat(30) }).features.diarization).toBe(true);
      expect(loadConfig({ ...base, HF_TOKEN_FILE: "/run/secrets/hf" }).features.diarization).toBe(true);
      expect(loadConfig({ ...base, HF_TOKEN: "" }).features.diarization).toBe(false);
    });

    it("un valor que no es booleano falla al arrancar", () => {
      expect(() => loadConfig({ ...base, DIARIZATION_ENABLED: "quizá" })).toThrow(/DIARIZATION_ENABLED/);
    });

    it("el token nunca queda en la configuración", () => {
      const config = loadConfig({ ...base, HF_TOKEN: "hf_" + "x".repeat(30) });
      expect(JSON.stringify(config)).not.toContain("hf_xxx");
    });
  });

  it("aplica valores por defecto seguros", () => {
    const config = loadConfig(base);
    expect(config.host).toBe("127.0.0.1"); // sin autenticación aún: no se expone a la red por defecto
    expect(config.port).toBe(3000);
    expect(config.redis.port).toBe(6379);
    expect(config.maxUploadBytes).toBe(4 * 1024 ** 3);
    expect(config.s3.forcePathStyle).toBe(true);
  });

  it.each(["DATABASE_URL", "REDIS_HOST", "REDIS_PASSWORD", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"])(
    "falla al arrancar si falta %s",
    (name) => {
      const env: Record<string, string | undefined> = { ...base };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it.each(["abc", "-5", "0", "1.5"])("rechaza un PORT inválido (%s)", (port) => {
    expect(() => loadConfig({ ...base, PORT: port })).toThrow(/PORT/);
  });

  it("rechaza un MAX_UPLOAD_BYTES inválido", () => {
    expect(() => loadConfig({ ...base, MAX_UPLOAD_BYTES: "mucho" })).toThrow(/MAX_UPLOAD_BYTES/);
  });
});

describe("loadConfig: interfaz web", () => {
  it("por defecto sirve apps/web/public, que queda junto al API", () => {
    const root = loadConfig(base).webRoot;
    expect(root?.replaceAll(String.fromCharCode(92), "/")).toMatch(/\/apps\/web\/public$/);
  });

  it("WEB_ROOT cambia la carpeta y se resuelve a ruta absoluta", () => {
    const root = loadConfig({ ...base, WEB_ROOT: "./mi-web" }).webRoot;
    expect(root?.replaceAll(String.fromCharCode(92), "/")).toMatch(/\/mi-web$/);
    expect(isAbsolute(root ?? "")).toBe(true);
  });

  it.each(["off", "OFF", "none", "false"])("WEB_ROOT=%s desactiva la interfaz (despliegue solo de API)", (value) => {
    expect(loadConfig({ ...base, WEB_ROOT: value }).webRoot).toBeUndefined();
  });

  describe("ALLOW_PRIVATE_BASE_URLS (URL base propia, ADR 0022)", () => {
    it("apagada por defecto: sin valor, vacía o false", () => {
      expect(loadConfig(base).byok.allowPrivateBaseUrls).toBe(false);
      expect(loadConfig({ ...base, ALLOW_PRIVATE_BASE_URLS: "" }).byok.allowPrivateBaseUrls).toBe(false);
      expect(loadConfig({ ...base, ALLOW_PRIVATE_BASE_URLS: "false" }).byok.allowPrivateBaseUrls).toBe(false);
      expect(loadConfig({ ...base, ALLOW_PRIVATE_BASE_URLS: "0" }).byok.allowPrivateBaseUrls).toBe(false);
    });

    it.each(["true", "TRUE", " true ", "1"])("se enciende solo con un valor explícito: %j", (value) => {
      expect(loadConfig({ ...base, ALLOW_PRIVATE_BASE_URLS: value }).byok.allowPrivateBaseUrls).toBe(true);
    });

    it.each(["yes", "si", "on", "ture", "2", "verdadero"])("un valor ambiguo hace fallar el arranque en vez de encender o apagar una defensa a ciegas: %j", (value) => {
      expect(() => loadConfig({ ...base, ALLOW_PRIVATE_BASE_URLS: value })).toThrow(/ALLOW_PRIVATE_BASE_URLS/);
    });
  });

  describe("APP_SECRET (claves externas propias, ADR 0020)", () => {
    const HEX = "9f2c6a41d07b83e5a1c4f6d2b9087e53c1a4d6f8b20e7395a1c4d6f8e0b2a497"; // randomBytes(32).toString("hex")
    const BASE64URL = "k3Jx9mQ2vL8nR5tY7uZ1aB4cD6eF0gH2iJ4kL6mN8oP"; // 43 caracteres, como randomBytes(32).toString("base64url")
    const BASE64 = "k3Jx9mQ2vL8nR5tY7uZ1aB4cD6eF0gH2iJ4kL6mN8oP=";

    it("sin valor la función queda apagada: no hay secreto y el resto de la configuración carga", () => {
      expect(loadConfig(base).byok.appSecret).toBeUndefined();
      expect(loadConfig({ ...base, APP_SECRET: "" }).byok.appSecret).toBeUndefined();
    });

    it.each([
      ["hexadecimal de 32 bytes", HEX],
      ["base64url de 32 bytes", BASE64URL],
      ["base64 de 32 bytes", BASE64],
    ])("acepta un secreto aleatorio: %s", (_name, value) => {
      expect(loadConfig({ ...base, APP_SECRET: value }).byok.appSecret).toBe(value);
    });

    it.each([
      ["demasiado corto", "corto-pero-secreto"],
      ["hexadecimal de solo 20 bytes", HEX.slice(0, 40)],
      ["hexadecimal de 25 bytes (50 caracteres)", HEX.slice(0, 50)],
      ["un carácter repetido", "a".repeat(64)],
      ["pocos caracteres distintos", "ab".repeat(32)],
      ["una frase con espacios", "una frase larga de mas de treinta y dos bytes"],
      ["texto con símbolos fuera del alfabeto", "!".repeat(20) + HEX],
      ["no ASCII", "ñ".repeat(48)],
    ])("rechaza al arrancar un secreto que no parece aleatorio: %s, sin repetir el valor", (_name, value) => {
      expect(() => loadConfig({ ...base, APP_SECRET: value })).toThrow(/APP_SECRET/);
      let message = "";
      try {
        loadConfig({ ...base, APP_SECRET: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(value);
    });

    it("espacios al principio o al final (error típico de un .env) fallan al arrancar", () => {
      expect(() => loadConfig({ ...base, APP_SECRET: ` ${HEX}` })).toThrow(/APP_SECRET.*espacios/);
      expect(() => loadConfig({ ...base, APP_SECRET: `${HEX}
` })).toThrow(/APP_SECRET.*espacios/);
    });
  });

  describe("canal interno del worker (ADR 0020)", () => {
    const TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c";
    const SECRET = "9f2c6a41d07b83e5a1c4f6d2b9087e53c1a4d6f8b20e7395a1c4d6f8e0b2a497";

    it("apagado por defecto: sin puerto no hay listener ni hace falta el token", () => {
      expect(loadConfig(base).internal).toMatchObject({ port: 0, host: "127.0.0.1", workerToken: undefined });
    });

    it("con INTERNAL_PORT y WORKER_INTERNAL_TOKEN queda configurado, solo en el loopback si no se dice otra cosa", () => {
      const config = loadConfig({ ...base, INTERNAL_PORT: "3100", WORKER_INTERNAL_TOKEN: TOKEN });
      expect(config.internal).toMatchObject({ port: 3100, host: "127.0.0.1", workerToken: TOKEN });
      expect(loadConfig({ ...base, INTERNAL_PORT: "3100", INTERNAL_HOST: "0.0.0.0", WORKER_INTERNAL_TOKEN: TOKEN }).internal.host).toBe("0.0.0.0");
    });

    it("un puerto sin token falla al arrancar: el listener nunca queda abierto sin autenticación", () => {
      expect(() => loadConfig({ ...base, INTERNAL_PORT: "3100" })).toThrow(/WORKER_INTERNAL_TOKEN/);
    });

    it.each([
      ["corto", "corto"],
      ["una frase", "una frase larga con espacios de mas de treinta y dos bytes"],
      ["un carácter repetido", "a".repeat(64)],
    ])("un token que no parece aleatorio falla al arrancar, sin repetirlo: %s", (_name, value) => {
      expect(() => loadConfig({ ...base, INTERNAL_PORT: "3100", WORKER_INTERNAL_TOKEN: value })).toThrow(/WORKER_INTERNAL_TOKEN/);
      let message = "";
      try {
        loadConfig({ ...base, INTERNAL_PORT: "3100", WORKER_INTERNAL_TOKEN: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(value);
    });

    it("el token no puede ser el mismo valor que APP_SECRET (dos secretos, dos funciones)", () => {
      expect(() => loadConfig({ ...base, APP_SECRET: SECRET, INTERNAL_PORT: "3100", WORKER_INTERNAL_TOKEN: SECRET })).toThrow(/WORKER_INTERNAL_TOKEN.*APP_SECRET/);
    });

    it("un puerto fuera de rango o que no es número falla", () => {
      expect(() => loadConfig({ ...base, INTERNAL_PORT: "70000", WORKER_INTERNAL_TOKEN: TOKEN })).toThrow(/INTERNAL_PORT/);
      expect(() => loadConfig({ ...base, INTERNAL_PORT: "abc", WORKER_INTERNAL_TOKEN: TOKEN })).toThrow(/INTERNAL_PORT/);
    });

    it("el límite de peticiones por minuto tiene un valor por defecto y se puede cambiar", () => {
      expect(loadConfig({ ...base, INTERNAL_PORT: "3100", WORKER_INTERNAL_TOKEN: TOKEN }).internal.rateLimitPerMinute).toBe(120);
      expect(loadConfig({ ...base, INTERNAL_PORT: "3100", WORKER_INTERNAL_TOKEN: TOKEN, INTERNAL_RATE_LIMIT_PER_MINUTE: "30" }).internal.rateLimitPerMinute).toBe(30);
    });
  });
});
