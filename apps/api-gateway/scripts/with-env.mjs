// Ejecuta un comando con las variables de entorno de desarrollo derivadas del .env de la raíz.
//
//   node scripts/with-env.mjs <owner|api|worker> -- <comando> [args...]
//
// Pone DATABASE_URL con el rol elegido y los datos de Redis y S3 apuntando a localhost (la
// infraestructura de `npm run infra:up`). Los secretos se leen del .env y nunca se imprimen.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const [rol, separador, ...comando] = process.argv.slice(2);
if (!["owner", "api", "worker"].includes(rol) || separador !== "--" || comando.length === 0) {
  console.error("Uso: node scripts/with-env.mjs <owner|api|worker> -- <comando> [args...]");
  process.exit(2);
}

const archivo = join(raiz, ".env");
if (!existsSync(archivo)) {
  console.error("Falta el .env de la raíz (copia .env.example y rellénalo).");
  process.exit(2);
}
const env = {};
for (const linea of readFileSync(archivo, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(linea.replace(/\s+#.*$/, ""));
  if (m) env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
}
const requerido = (n) => {
  if (!env[n]) throw new Error(`Falta ${n} en .env`);
  return env[n];
};
const db = env.POSTGRES_DB ?? "captionforge";
const usuario = { owner: "cf_owner", api: "cf_api", worker: "cf_worker" }[rol];
const clave = requerido({ owner: "CF_OWNER_DB_PASSWORD", api: "CF_API_DB_PASSWORD", worker: "CF_WORKER_DB_PASSWORD" }[rol]);

const urlDe = (u, c) => `postgresql://${u}:${c}@127.0.0.1:5432/${db}`;

// En Windows npx/npm son .cmd y exigen shell; con shell se pasa una sola cadena (sin argumentos aparte).
const enWindows = process.platform === "win32";
const hijo = spawn(enWindows ? comando.join(" ") : comando[0], enWindows ? [] : comando.slice(1), {
  stdio: "inherit",
  shell: enWindows,
  env: {
    ...process.env,
    DATABASE_URL: urlDe(usuario, clave),
    // Solo para las pruebas de privilegios: las tres cuentas para comprobar qué puede y qué no puede cada una.
    DATABASE_URL_OWNER: urlDe("cf_owner", requerido("CF_OWNER_DB_PASSWORD")),
    DATABASE_URL_API: urlDe("cf_api", requerido("CF_API_DB_PASSWORD")),
    DATABASE_URL_WORKER: urlDe("cf_worker", requerido("CF_WORKER_DB_PASSWORD")),
    // Clave del tenant "Default" (ADR 0015): la semilla (`npm run seed`) la da de alta y la interfaz web local la recibe.
    ...(env.DEFAULT_API_KEY ? { DEFAULT_API_KEY: env.DEFAULT_API_KEY, WEB_API_KEY: process.env.WEB_API_KEY ?? env.DEFAULT_API_KEY } : {}),
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "6379",
    REDIS_PASSWORD: requerido("REDIS_PASSWORD"),
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: env.S3_BUCKET ?? "captionforge",
    S3_FORCE_PATH_STYLE: "true",
    // Desarrollo y pruebas: las pruebas crean decenas de trabajos por minuto desde 127.0.0.1 y el
    // recolector no debe actuar solo mientras se prueba. En producción mandan los valores por defecto
    // (límites activos); las pruebas de seguridad y del recolector construyen su propia configuración.
    RATE_LIMIT_PER_MINUTE: process.env.RATE_LIMIT_PER_MINUTE ?? "0",
    UPLOAD_RATE_LIMIT_PER_MINUTE: process.env.UPLOAD_RATE_LIMIT_PER_MINUTE ?? "0",
    REAPER_INTERVAL_SECONDS: process.env.REAPER_INTERVAL_SECONDS ?? "0",
    // cf_api admite 20 conexiones en total: con varias instancias del API en paralelo (una por archivo de prueba) el pool por defecto (10) las agotaría.
    DB_POOL_MAX: process.env.DB_POOL_MAX ?? "3",
    S3_ACCESS_KEY: rol === "worker" ? (env.S3_WORKER_ACCESS_KEY ?? "cf-worker") : (env.S3_API_ACCESS_KEY ?? "cf-api"),
    S3_SECRET_KEY: rol === "worker" ? requerido("S3_WORKER_SECRET_KEY") : requerido("S3_API_SECRET_KEY"),
  },
});
hijo.on("exit", (codigo) => process.exit(codigo ?? 1));
