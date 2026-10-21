// H9: los workflows de GitHub Actions siguen el mínimo privilegio.
//   1. Un bloque `permissions:` en el nivel más alto (el GITHUB_TOKEN no depende del ajuste del repositorio).
//   2. Sin permisos de escritura en ese nivel: la escritura (p. ej. `id-token: write` para publicar) va en el job.
//   3. Toda acción externa fijada por SHA completo (una etiqueta o una rama se pueden mover bajo nuestros pies).
// Uso: `node tools/check-workflows.mjs` (sale con código 1 si hay incumplimientos).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA_PIN = /@[0-9a-f]{40}$/;

/** Devuelve la lista de incumplimientos de un workflow (vacía si cumple). */
export function checkWorkflow(name, text) {
  const problems = [];
  const lines = text.split(/\r?\n/);

  const start = lines.findIndex((line) => /^permissions\s*:/.test(line));
  if (start === -1) {
    problems.push(`${name}: falta el bloque 'permissions:' en el nivel más alto (p. ej. 'permissions:\n  contents: read').`);
  } else {
    const inline = lines[start].replace(/^permissions\s*:/, "").replace(/#.*/, "").trim();
    const block = [];
    for (let i = start + 1; i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i])); i++) block.push(lines[i]);
    const declared = [inline, ...block].join("\n");
    if (/write-all/.test(declared) || /:\s*write\b/.test(declared)) {
      problems.push(`${name}: 'permissions:' global concede escritura; déjala en solo lectura y concede la escritura dentro del job que la necesita.`);
    }
  }

  lines.forEach((line, index) => {
    const match = /^\s*(?:-\s*)?uses\s*:\s*(\S+)/.exec(line.replace(/\s#.*$/, ""));
    if (!match) return;
    const target = match[1].replace(/^["']|["']$/g, "");
    if (target.startsWith("./") || target.startsWith("docker://")) return;
    if (!SHA_PIN.test(target)) {
      problems.push(`${name}:${index + 1}: '${target}' no está fijada por SHA de 40 caracteres.`);
    }
  });
  return problems;
}

function main() {
  const folder = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  const files = readdirSync(folder).filter((file) => /\.ya?ml$/.test(file));
  const problems = files.flatMap((file) => checkWorkflow(file, readFileSync(folder + file, "utf8")));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} incumplimiento(s) en ${files.length} workflow(s).`);
    process.exit(1);
  }
  console.log(`${files.length} workflow(s) cumplen: permissions global de solo lectura y acciones fijadas por SHA.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
