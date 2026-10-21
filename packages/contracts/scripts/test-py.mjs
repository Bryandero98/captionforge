// Ejecuta las pruebas de paridad en Python con el venv del contrato.
import { spawnSync } from "node:child_process";

import { ROOT, contractsPython } from "./lib.mjs";

const result = spawnSync(contractsPython(), ["-m", "pytest", "python-tests", "-q", "-p", "no:cacheprovider"], {
  cwd: ROOT,
  stdio: "inherit",
  // Que importar los modelos generados no deje __pycache__ dentro de generated/.
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
if (result.error) console.error(`No se pudo ejecutar Python (${contractsPython()}): ${result.error.message}`);
process.exit(result.status ?? 1);
