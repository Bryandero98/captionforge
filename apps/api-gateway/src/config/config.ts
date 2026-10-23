import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDERS, type ProviderEndpoints, type ProviderId } from "../auth/providers.js";
import { MIN_APP_SECRET_BYTES } from "../external-keys/external-key-crypto.js";

export const APP_CONFIG = Symbol("APP_CONFIG");

/** Credenciales de un proveedor de inicio de sesión. `endpoints` solo se cambia en las pruebas (un proveedor falso). */
export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  endpoints: ProviderEndpoints;
}

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
  /** Carpeta de la interfaz web que sirve el propio API (mismo origen: sin CORS). undefined = no se sirve (despliegue solo de API). */
  webRoot: string | undefined;
  /** Inicio de sesión de personas (ADR 0016). */
  auth: {
    /** Dirección pública del servicio (esquema://host[:puerto], sin ruta): de aquí salen el callback de OAuth y la marca Secure de las cookies. */
    publicUrl: string;
    /** true = instalación de una sola persona: la interfaz recibe la clave por defecto en /web-config.json y no pide iniciar sesión. */
    localMode: boolean;
    sessionTtlMs: number;
    providers: { github?: ProviderConfig; google?: ProviderConfig };
  };
  /** Registros y métricas (ADR 0018). `metricsPort` 0 desactiva el servidor de métricas; escucha en `metricsHost`, nunca en el puerto público. */
  observability: { logFormat: "json" | "text"; logRequests: boolean; metricsHost: string; metricsPort: number };
  /** Funciones opcionales que el servidor anuncia en GET /v1/capabilities. */
  features: { diarization: boolean };
  /**
   * Claves externas propias (BYOK, ADR 0020). Sin `appSecret` la función queda apagada: nunca se cifra con un valor por defecto.
   * Es un secreto: no se registra ni se devuelve en ninguna respuesta.
   */
  byok: { appSecret: string | undefined };
  /**
   * Canal interno del worker (ADR 0020), en un puerto aparte que no se publica. `port` 0 = apagado. `workerToken` es un secreto: no se
   * registra ni se devuelve. `rateLimitPerMinute` 0 = sin límite.
   */
  internal: { host: string; port: number; workerToken: string | undefined; rateLimitPerMinute: number };
  /** Recolector de trabajos huérfanos (ver ReaperService). intervalMs = 0 lo desactiva. */
  reaper: { intervalMs: number; staleRunningMs: number; queuedGraceMs: number };
  /** Seguridad del API: clave por defecto de la interfaz web y límites de uso por IP (0 = sin límite). */
  security: {
    /**
     * Clave que la interfaz web local recibe en GET /web-config.json (el MVP no tiene inicio de sesión: ADR 0015). Es
     * la misma DEFAULT_API_KEY que la semilla da de alta. Sin ella la ruta no existe y la clave se pega a mano en la interfaz.
     */
    webApiKey: string | undefined;
    rateLimitPerMinute: number;
    uploadRateLimitPerMinute: number;
    /** Cuotas por tenant (ADR 0017, 0 = sin límite): subidas por hora (contador en Redis) y trabajos en cola o en curso. */
    tenantUploadsPerHour: number;
    tenantMaxQueuedJobs: number;
    /** Lista de redes de confianza (IP o CIDR) o booleano. `true` confía en TODA cabecera X-Forwarded-For. */
    trustProxy: boolean | string[];
    /** Operaciones largas a la vez (0 = sin límite): subidas en total y por cliente, y flujos SSE en total y por cliente. */
    maxConcurrentUploads: number;
    maxConcurrentUploadsPerClient: number;
    /** Ritmo mínimo de una subida, medido por ventanas: por debajo se corta con 408 (0 = sin mínimo). */
    uploadMinBytesPerSecond: number;
    uploadRateWindowMs: number;
    maxEventStreams: number;
    maxEventStreamsPerClient: number;
    eventStreamMaxMs: number;
    /** Orígenes de navegador autorizados (CORS y CSRF), ya normalizados. Vacío = ninguno: solo mismo origen. */
    allowedOrigins: string[];
    /** Nombres de host con los que se puede llegar al API (anti DNS rebinding), sin puerto. */
    allowedHosts: string[];
  };
}

/**
 * TRUST_PROXY: `false` (por defecto), `true` o una lista de IP/CIDR de proxies de confianza.
 * Con `true`, Fastify toma la entrada más a la izquierda de X-Forwarded-For, que controla el cliente: un límite por
 * IP se esquiva rotando esa cabecera. Detrás de un proxy propio, lista su dirección o red: así el cliente es la
 * última entrada que no es de confianza. (El modo numérico de Fastify 5.12 devuelve la IP del socket, por eso no se admite.)
 */
function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const value = (raw ?? "").trim();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  const entries = value.split(",").map((entry) => entry.trim());
  const valid = entries.every((entry) => {
    const [address = "", prefix] = entry.split("/");
    return isIP(address) !== 0 && (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (isIP(address) === 4 ? 32 : 128)));
  });
  if (!valid) throw new Error(`TRUST_PROXY debe ser true, false o una lista de IP/CIDR (recibido "${raw}")`);
  return entries;
}

/**
 * ALLOWED_ORIGINS: lista de orígenes (esquema://host[:puerto]) separados por comas. Se normalizan como los
 * envía el navegador. Nunca comodines: `*` junto con una clave de API o con datos propios es la puerta que
 * esta lista existe para cerrar.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  return entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`ALLOWED_ORIGINS: "${entry}" no es un origen válido (esquema://host[:puerto], p. ej. http://localhost:5173)`);
    }
    const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !bare || entry === "*") {
      throw new Error(`ALLOWED_ORIGINS: "${entry}" debe ser solo esquema://host[:puerto] con http o https, sin ruta ni credenciales`);
    }
    return url.origin;
  });
}

/**
 * ALLOWED_HOSTS: nombres con los que se puede llegar al API, separados por comas, sin puerto ni comodines.
 * Por defecto solo el bucle local: quien lo publique con un nombre propio debe declararlo.
 */
function parseAllowedHosts(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
  if (entries.length === 0) return ["localhost", "127.0.0.1", "[::1]"];
  for (const entry of entries) {
    if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(entry)) {
      throw new Error(`ALLOWED_HOSTS: "${entry}" no es un nombre de host válido (sin puerto, ruta ni comodines)`);
    }
  }
  return entries;
}

/**
 * WEB_ROOT: carpeta de la interfaz. Por defecto `apps/web/public`, que queda a la misma distancia del API tanto
 * en el código fuente (src/config) como compilado (dist/config). `off`, `none` o `false` la desactivan.
 */
function parseWebRoot(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (value === "") return fileURLToPath(new URL("../../../web/public", import.meta.url));
  if (["off", "none", "false"].includes(value.toLowerCase())) return undefined;
  return resolve(value);
}

/**
 * DIARIZATION_ENABLED (identificar quién habla): valor explícito true/1/false/0; sin valor se deduce de que el
 * entorno del servicio tenga token de Hugging Face (HF_TOKEN o HF_TOKEN_FILE). Nunca se guarda el token.
 */
function parseDiarization(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.DIARIZATION_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") return Boolean(env.HF_TOKEN || env.HF_TOKEN_FILE);
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`DIARIZATION_ENABLED debe ser true o false (recibido "${env.DIARIZATION_ENABLED}")`);
}

/**
 * GITHUB_CLIENT_ID/SECRET y GOOGLE_CLIENT_ID/SECRET: un proveedor se activa si tiene las dos; con una sola, el arranque falla
 * (una configuración a medias suele ser un secreto mal copiado, y es mejor verlo ahora que en el primer inicio de sesión).
 */
function parseProvider(env: NodeJS.ProcessEnv, id: ProviderId): ProviderConfig | undefined {
  const prefix = id.toUpperCase();
  const clientId = (env[`${prefix}_CLIENT_ID`] ?? "").trim();
  const clientSecret = (env[`${prefix}_CLIENT_SECRET`] ?? "").trim();
  if (clientId === "" && clientSecret === "") return undefined;
  if (clientId === "" || clientSecret === "") throw new Error(`${prefix}_CLIENT_ID y ${prefix}_CLIENT_SECRET deben definirse juntos`);
  return { clientId, clientSecret, endpoints: PROVIDERS[id].endpoints };
}

/** LOG_FORMAT (`text` por defecto, `json` en el contenedor), LOG_REQUESTS (una línea por petición; por defecto solo con json) y servidor de métricas. */
function parseObservability(env: NodeJS.ProcessEnv, integer: (name: string, fallback: number, options?: { allowZero?: boolean; max?: number }) => number): AppConfig["observability"] {
  const format = (env.LOG_FORMAT ?? "text").trim().toLowerCase();
  if (format !== "text" && format !== "json") throw new Error(`LOG_FORMAT debe ser text o json (recibido "${env.LOG_FORMAT}")`);
  const requests = (env.LOG_REQUESTS ?? "").trim().toLowerCase();
  if (requests !== "" && requests !== "true" && requests !== "false") throw new Error(`LOG_REQUESTS debe ser true o false (recibido "${env.LOG_REQUESTS}")`);
  return {
    logFormat: format,
    logRequests: requests === "" ? format === "json" : requests === "true",
    // Solo el loopback por defecto: en el contenedor se pone 0.0.0.0 y el puerto no se publica en el host.
    metricsHost: (env.METRICS_HOST ?? "127.0.0.1").trim(),
    metricsPort: integer("METRICS_PORT", 9090, { allowZero: true, max: 65_535 }),
  };
}

/** Alfabeto de un secreto aleatorio en hexadecimal, base64 o base64url, de al menos 32 bytes (43 caracteres en base64). */
const SECRET_FORMAT = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;
/** Un secreto aleatorio usa muchos símbolos distintos; `aaaa…` o `abab…` pasan el largo pero no son un secreto. */
const SECRET_MIN_DISTINCT = 12;

/**
 * Un secreto del servicio (APP_SECRET, WORKER_INTERNAL_TOKEN): sin valor, `undefined`. Definido, debe ser ALEATORIO (hex, base64 o
 * base64url) de 32 bytes o más: HKDF no estira un secreto débil, y con un volcado de la base o un token adivinable alguien podría probar
 * frases sin conexión. Ningún espacio ni salto de línea en los extremos (un .env mal copiado cambiaría la clave derivada y dejaría
 * ilegibles las claves ya guardadas). El mensaje nunca repite el valor.
 */
function parseRandomSecret(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw !== raw.trim()) throw new Error(`${name} no puede llevar espacios ni saltos de línea al principio o al final`);
  // En hexadecimal cada byte son 2 caracteres: 32 bytes = 64 (el largo de 43 es el del base64).
  const hexOnly = /^[0-9a-fA-F]+$/.test(raw);
  if (!SECRET_FORMAT.test(raw) || (hexOnly && raw.length < MIN_APP_SECRET_BYTES * 2) || new Set(raw).size < SECRET_MIN_DISTINCT) {
    throw new Error(
      `${name} debe ser un secreto aleatorio de ${MIN_APP_SECRET_BYTES} bytes o más en hexadecimal o base64, no una frase (genera uno con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")`,
    );
  }
  return raw;
}

/**
 * Canal interno del worker (ADR 0020): un listener aparte que entrega al worker la clave externa de SU trabajo. INTERNAL_PORT=0 (por
 * defecto) lo apaga. Encendido exige WORKER_INTERNAL_TOKEN (nunca queda abierto sin autenticación) y que no sea el mismo valor que
 * APP_SECRET. Escucha en el loopback salvo que se diga otra cosa; en Docker se pone 0.0.0.0 y el puerto NO se publica.
 */
function parseInternal(env: NodeJS.ProcessEnv, integer: (name: string, fallback: number, options?: { allowZero?: boolean; max?: number }) => number, appSecret: string | undefined): AppConfig["internal"] {
  const port = integer("INTERNAL_PORT", 0, { allowZero: true, max: 65_535 });
  const workerToken = parseRandomSecret("WORKER_INTERNAL_TOKEN", env.WORKER_INTERNAL_TOKEN);
  if (port > 0 && workerToken === undefined) throw new Error("INTERNAL_PORT requiere WORKER_INTERNAL_TOKEN: el canal interno no se abre sin autenticación");
  if (workerToken !== undefined && workerToken === appSecret) throw new Error("WORKER_INTERNAL_TOKEN no puede ser el mismo valor que APP_SECRET");
  return { host: (env.INTERNAL_HOST ?? "127.0.0.1").trim() || "127.0.0.1", port, workerToken, rateLimitPerMinute: integer("INTERNAL_RATE_LIMIT_PER_MINUTE", 120, { allowZero: true }) };
}

/** PUBLIC_URL: origen público del servicio. Sin valor, el de la dirección local. */
function parsePublicUrl(raw: string | undefined, port: number): string {
  const value = (raw ?? "").trim();
  if (value === "") return `http://localhost:${port}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_URL "${value}" no es una URL válida (esquema://host[:puerto], p. ej. https://captions.ejemplo.com)`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new Error(`PUBLIC_URL "${value}" debe ser solo esquema://host[:puerto] con http o https, sin ruta ni credenciales`);
  }
  return url.origin;
}

/** Lee y valida el entorno; falla al arrancar (no a mitad de una petición) si falta algo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Falta la variable de entorno ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, { allowZero = false, max = Number.MAX_SAFE_INTEGER } = {}): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || (value === 0 && !allowZero) || value > max) {
      throw new Error(`${name} debe ser un entero ${allowZero ? "no negativo" : "positivo"}${max < Number.MAX_SAFE_INTEGER ? ` de como máximo ${max}` : ""} (recibido "${raw}")`);
    }
    return value;
  };
  // Fuera del modo local la interfaz inicia sesión como cualquiera: no se le entrega ninguna clave.
  const localMode = (env.LOCAL_MODE ?? "true").trim().toLowerCase() !== "false";
  const webApiKey = localMode ? env.WEB_API_KEY || undefined : undefined;
  if (webApiKey !== undefined && webApiKey.length < 32) {
    throw new Error("WEB_API_KEY debe tener al menos 32 caracteres (es la DEFAULT_API_KEY del .env)");
  }

  const appSecret = parseRandomSecret("APP_SECRET", env.APP_SECRET);

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
    webRoot: parseWebRoot(env.WEB_ROOT),
    auth: {
      publicUrl: parsePublicUrl(env.PUBLIC_URL, integer("PORT", 3000)),
      localMode: (env.LOCAL_MODE ?? "true").trim().toLowerCase() !== "false",
      sessionTtlMs: integer("SESSION_TTL_DAYS", 30, { max: 365 }) * 86_400_000,
      providers: { github: parseProvider(env, "github"), google: parseProvider(env, "google") },
    },
    features: { diarization: parseDiarization(env) },
    byok: { appSecret },
    internal: parseInternal(env, integer, appSecret),
    observability: parseObservability(env, integer),
    reaper: {
      intervalMs: integer("REAPER_INTERVAL_SECONDS", 60, { allowZero: true }) * 1000,
      // Más que cualquier fase sin progreso del worker (ffmpeg corta a los 5 min sin actividad).
      staleRunningMs: integer("JOB_STALE_MINUTES", 20) * 60_000,
      queuedGraceMs: integer("QUEUED_GRACE_MINUTES", 5) * 60_000,
    },
    security: {
      webApiKey,
      rateLimitPerMinute: integer("RATE_LIMIT_PER_MINUTE", 240, { allowZero: true }),
      uploadRateLimitPerMinute: integer("UPLOAD_RATE_LIMIT_PER_MINUTE", 10, { allowZero: true }),
      tenantUploadsPerHour: integer("TENANT_UPLOADS_PER_HOUR", 60, { allowZero: true }),
      tenantMaxQueuedJobs: integer("TENANT_MAX_QUEUED_JOBS", 20, { allowZero: true }),
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      // Cada subida retiene ~15 MiB (3 partes de 5 MiB): con 4 a la vez son ~60 MiB de los 512 del contenedor.
      maxConcurrentUploads: integer("MAX_CONCURRENT_UPLOADS", 4, { allowZero: true }),
      maxConcurrentUploadsPerClient: integer("MAX_CONCURRENT_UPLOADS_PER_CLIENT", 2, { allowZero: true }),
      // 16 KiB/s: cualquier cliente real lo supera con mucho; un goteo de bytes que retiene la plaza, no.
      uploadMinBytesPerSecond: integer("UPLOAD_MIN_BYTES_PER_SECOND", 16_384, { allowZero: true }),
      uploadRateWindowMs: integer("UPLOAD_RATE_WINDOW_SECONDS", 30, { max: 3600 }) * 1000,
      maxEventStreams: integer("MAX_EVENT_STREAMS", 200, { allowZero: true }),
      maxEventStreamsPerClient: integer("MAX_EVENT_STREAMS_PER_CLIENT", 10, { allowZero: true }),
      // Pasado este tiempo el servidor cierra el flujo y el cliente SSE reconecta solo (EventSource).
      allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
      allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
      eventStreamMaxMs: integer("EVENT_STREAM_MAX_SECONDS", 1800, { allowZero: true, max: 86_400 }) * 1000,
    },
  };
}
