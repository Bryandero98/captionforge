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
