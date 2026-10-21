// Ejecuta pytest del worker con el entorno de desarrollo (rol cf_worker, Redis y S3 locales).
//   node scripts/test.mjs [argumentos de pytest...]
// Python: AI_WORKER_PYTHON, o apps/ai-worker/.venv, o el .venv de la raíz del repositorio.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = join(dirname(fileURLToPath(import.meta.url)), "..");
const raiz = join(aqui, "..", "..");
const candidatos = [
  process.env.AI_WORKER_PYTHON,
  join(aqui, ".venv", "Scripts", "python.exe"),
  join(aqui, ".venv", "bin", "python"),
  join(raiz, ".venv", "Scripts", "python.exe"),
  join(raiz, ".venv", "bin", "python"),
].filter(Boolean);
const python = candidatos.find((p) => existsSync(p));
if (!python) {
  console.error("No hay entorno Python del worker (ver requirements-dev.txt) ni AI_WORKER_PYTHON.");
  process.exit(2);
}

const conEntorno = join(raiz, "apps", "api-gateway", "scripts", "with-env.mjs");
const resultado = spawnSync(
  process.execPath,
  [conEntorno, "worker", "--", `"${python}"`, "-m", "pytest", ...process.argv.slice(2)],
  { cwd: aqui, stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
);
process.exit(resultado.status ?? 1);
