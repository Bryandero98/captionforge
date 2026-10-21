// Genera los modelos Pydantic v2 desde los JSON Schema: generated/python/ (paquete instalable).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SCHEMAS_DIR,
  contractsPython,
  isMain,
  messageSchemaNames,
  outDirFromArgs,
  pythonModuleName,
  readSchema,
} from "./lib.mjs";

const PACKAGE = "captionforge_contracts";
const lf = (text) => text.replace(/\r\n/g, "\n");

const PYPROJECT = `# AUTO-GENERADO desde packages/contracts. NO EDITAR A MANO.
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "captionforge-contracts"
version = "1.0.0"
description = "Modelos Pydantic del contrato API Gateway <-> AI Worker de CaptionForge."
requires-python = ">=3.11"
dependencies = ["pydantic>=2.7"]

[tool.setuptools]
packages = ["${PACKAGE}"]

[tool.setuptools.package-data]
${PACKAGE} = ["py.typed"]
`;

export function generatePython(outDir) {
  const python = contractsPython();
  const pyDir = join(outDir, "python");
  const pkgDir = join(pyDir, PACKAGE);
  rmSync(pyDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });

  const exports = [];
  for (const name of messageSchemaNames()) {
    const schema = readSchema(name);
    const module = pythonModuleName(name);
    const result = spawnSync(
      python,
      [
        "-m", "datamodel_code_generator",
        "--input", join(SCHEMAS_DIR, `${name}.json`),
        "--input-file-type", "jsonschema",
        "--output", join(pkgDir, `${module}.py`),
        "--output-model-type", "pydantic_v2.BaseModel",
        "--target-python-version", "3.11",
        "--use-annotated",
        "--use-standard-collections",
        "--use-union-operator",
        "--disable-timestamp",
        "--use-title-as-name",
        "--collapse-root-models",
        "--formatters", "black", "isort",
      ],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) {
      const causa = result.error ? String(result.error) : result.stderr || result.stdout;
      throw new Error(`datamodel-codegen falló en ${name}:\n${causa}`);
    }
    exports.push({ module, title: schema.title });
  }

  const init = [
    '"""AUTO-GENERADO desde packages/contracts. NO EDITAR A MANO."""',
    "",
    ...exports.map((e) => `from .${e.module} import ${e.title}`),
    "",
    `__all__ = [${exports.map((e) => `"${e.title}"`).join(", ")}]`,
    "",
  ].join("\n");
  writeFileSync(join(pkgDir, "__init__.py"), lf(init));
  writeFileSync(join(pkgDir, "py.typed"), "");
  writeFileSync(join(pyDir, "pyproject.toml"), lf(PYPROJECT));

  // El generador escribe con el fin de línea del sistema: se normaliza a LF para que `check`
  // dé el mismo resultado en Windows, Linux y macOS.
  for (const name of messageSchemaNames()) {
    const file = join(pkgDir, `${pythonModuleName(name)}.py`);
    writeFileSync(file, lf(readFileSync(file, "utf8")));
  }
  return pyDir;
}

if (isMain(import.meta.url)) {
  const dir = generatePython(outDirFromArgs());
  console.log(`Pydantic generado en ${dir}`);
}
