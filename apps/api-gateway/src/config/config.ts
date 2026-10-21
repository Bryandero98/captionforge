export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  /** Conexiones máximas de esta instancia; debe quedar por debajo del CONNECTION LIMIT de cf_api (20) entre todas las réplicas. */
  databasePoolMax: number;
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
  /** Recolector de trabajos huérfanos (ver ReaperService). intervalMs = 0 lo desactiva. */
  reaper: { intervalMs: number; staleRunningMs: number; queuedGraceMs: number };
  /** Protección opcional del API: clave compartida y límites de uso por IP (0 = sin límite). */
  security: {
    apiKey: string | undefined;
    rateLimitPerMinute: number;
    uploadRateLimitPerMinute: number;
    trustProxy: boolean;
    /** Operaciones largas a la vez (0 = sin límite): subidas en total y flujos SSE en total y por cliente. */
    maxConcurrentUploads: number;
    maxEventStreams: number;
    maxEventStreamsPerClient: number;
    eventStreamMaxMs: number;
  };
}

/** Lee y valida el entorno; falla al arrancar (no a mitad de una petición) si falta algo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Falta la variable de entorno ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, { allowZero = false } = {}): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || (value === 0 && !allowZero)) {
      throw new Error(`${name} debe ser un entero ${allowZero ? "no negativo" : "positivo"} (recibido "${raw}")`);
    }
    return value;
  };
  const apiKey = env.API_KEY || undefined;
  if (apiKey !== undefined && apiKey.length < 24) {
    throw new Error("API_KEY debe tener al menos 24 caracteres (genera una con: openssl rand -hex 24)");
  }

  return {
    host: env.HOST ?? "127.0.0.1",
    port: integer("PORT", 3000),
    databaseUrl: need("DATABASE_URL"),
    databasePoolMax: integer("DB_POOL_MAX", 10),
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
    reaper: {
      intervalMs: integer("REAPER_INTERVAL_SECONDS", 60, { allowZero: true }) * 1000,
      // Más que cualquier fase sin progreso del worker (ffmpeg corta a los 5 min sin actividad).
      staleRunningMs: integer("JOB_STALE_MINUTES", 20) * 60_000,
      queuedGraceMs: integer("QUEUED_GRACE_MINUTES", 5) * 60_000,
    },
    security: {
      apiKey,
      rateLimitPerMinute: integer("RATE_LIMIT_PER_MINUTE", 240, { allowZero: true }),
      uploadRateLimitPerMinute: integer("UPLOAD_RATE_LIMIT_PER_MINUTE", 10, { allowZero: true }),
      trustProxy: (env.TRUST_PROXY ?? "false") === "true",
      // Cada subida retiene ~15 MiB (3 partes de 5 MiB): con 4 a la vez son ~60 MiB de los 512 del contenedor.
      maxConcurrentUploads: integer("MAX_CONCURRENT_UPLOADS", 4, { allowZero: true }),
      maxEventStreams: integer("MAX_EVENT_STREAMS", 200, { allowZero: true }),
      maxEventStreamsPerClient: integer("MAX_EVENT_STREAMS_PER_CLIENT", 10, { allowZero: true }),
      // Pasado este tiempo el servidor cierra el flujo y el cliente SSE reconecta solo (EventSource).
      eventStreamMaxMs: integer("EVENT_STREAM_MAX_SECONDS", 1800, { allowZero: true }) * 1000,
    },
  };
}
