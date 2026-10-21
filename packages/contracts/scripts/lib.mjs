// Utilidades compartidas por los generadores y las pruebas del contrato.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMAS_DIR = join(ROOT, "schemas");
export const EXAMPLES_DIR = join(ROOT, "examples");
export const DEFAULT_OUT_DIR = join(ROOT, "generated");

/** Esquemas "de mensaje" (todos menos el común), p. ej. "transcribe-job.v1". */
export function messageSchemaNames() {
  return readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("common."))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function readSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.json`), "utf8"));
}

/** "transcribe-job.v1" -> "transcribe_job_v1" (nombre de módulo Python válido). */
export function pythonModuleName(schemaName) {
  return schemaName.replace(/[-.]/g, "_");
}

/** true si el módulo actual es el script que se ejecutó (no un import). */
export function isMain(moduleUrl) {
  if (process.argv[1] === undefined) return false;
  // realpath en ambos lados: con enlaces simbólicos (macOS /var, workspaces) o distinta mayúscula de
  // unidad en Windows las rutas no coincidirían y el script saldría en silencio con código 0.
  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(process.argv[1]));
}

/** Python del venv del contrato (o CONTRACTS_PYTHON). Falla con un mensaje claro si no existe. */
export function contractsPython() {
  if (process.env.CONTRACTS_PYTHON) return process.env.CONTRACTS_PYTHON;
  const candidates = [
    join(ROOT, ".venv", "Scripts", "python.exe"),
    join(ROOT, ".venv", "bin", "python"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No hay entorno Python del contrato. Crea uno con:\n" +
        "  python -m venv packages/contracts/.venv\n" +
        "  packages/contracts/.venv/<Scripts|bin>/python -m pip install -r packages/contracts/requirements-dev.txt\n" +
        "o define CONTRACTS_PYTHON con la ruta de un Python que ya los tenga.",
    );
  }
  return found;
}

/** Directorio de salida: --out <dir> o el predeterminado (generated/). */
export function outDirFromArgs(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--out");
  return i >= 0 ? argv[i + 1] : DEFAULT_OUT_DIR;
}
