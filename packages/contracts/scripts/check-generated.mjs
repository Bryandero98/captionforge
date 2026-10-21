// Falla si generated/ no coincide con lo que producen hoy los esquemas (alguien editó un esquema
// sin regenerar, o editó un archivo generado a mano). Genera en una carpeta temporal y compara.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { generatePython } from "./gen-py.mjs";
import { generateTs } from "./gen-ts.mjs";
import { DEFAULT_OUT_DIR, isMain } from "./lib.mjs";

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__pycache__") continue; // lo crea Python al importar; no es parte de lo generado
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

export async function compareGenerated() {
  const tmp = mkdtempSync(join(tmpdir(), "captionforge-contracts-"));
  try {
    await generateTs(tmp);
    generatePython(tmp);
    const expected = listFiles(tmp).map((f) => relative(tmp, f));
    let actual = [];
    try {
      actual = listFiles(DEFAULT_OUT_DIR).map((f) => relative(DEFAULT_OUT_DIR, f));
    } catch {
      /* generated/ no existe todavía */
    }
    const problems = [];
    for (const f of expected.filter((x) => !actual.includes(x))) problems.push(`falta: ${f}`);
    for (const f of actual.filter((x) => !expected.includes(x))) problems.push(`sobra: ${f}`);
    for (const f of expected.filter((x) => actual.includes(x))) {
      const a = readFileSync(join(DEFAULT_OUT_DIR, f), "utf8");
      const b = readFileSync(join(tmp, f), "utf8");
      if (a !== b) problems.push(`distinto: ${f}`);
    }
    return problems;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const problems = await compareGenerated();
  if (problems.length > 0) {
    console.error("generated/ está desactualizado. Ejecuta `npm run contracts:gen` y sube el resultado.");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("generated/ coincide con los esquemas.");
}
