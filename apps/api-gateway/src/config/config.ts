export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redis: { host: string; port: number; password: string };
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
  };
  maxUploadBytes: number;
}

/** Lee y valida el entorno; falla al arrancar (no a mitad de una petición) si falta algo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Falta la variable de entorno ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} debe ser un entero positivo (recibido "${raw}")`);
    }
    return value;
  };

  return {
    host: env.HOST ?? "127.0.0.1",
    port: integer("PORT", 3000),
    databaseUrl: need("DATABASE_URL"),
    redis: { host: need("REDIS_HOST"), port: integer("REDIS_PORT", 6379), password: need("REDIS_PASSWORD") },
    s3: {
      endpoint: need("S3_ENDPOINT"),
      region: env.S3_REGION ?? "us-east-1",
      bucket: need("S3_BUCKET"),
      accessKey: need("S3_ACCESS_KEY"),
      secretKey: need("S3_SECRET_KEY"),
      forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    },
    maxUploadBytes: integer("MAX_UPLOAD_BYTES", 4 * 1024 ** 3),
  };
}
