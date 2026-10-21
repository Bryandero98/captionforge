// H9: los workflows de GitHub Actions siguen el mínimo privilegio.
//   1. Un bloque `permissions:` en el nivel más alto (el GITHUB_TOKEN no depende del ajuste del repositorio).
//   2. Sin permisos de escritura en ese nivel: la escritura (p. ej. `id-token: write` para publicar) va en el job.
//      Ningún job puede escalar a `write-all`.
//   3. Toda acción externa, de paso o de workflow reutilizable, fijada por SHA completo (una etiqueta o una rama se
//      pueden mover bajo nuestros pies) y toda imagen `docker://` por digest.
// Se analiza el árbol YAML (con alias resueltos), no el texto: comillas, mapas de una línea, comentarios en columna 0
// o alias no esquivan la comprobación.
// Uso: `node tools/check-workflows.mjs` (sale con código 1 si hay incumplimientos).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";

const SHA_PIN = /@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Los valores de un `permissions:` que conceden escritura (`write`, `write-all`) o que no se entienden. */
function writePermissions(permissions) {
  if (permissions === null || permissions === undefined) return [];
  if (typeof permissions === "string") return /^write(-all)?$/i.test(permissions.trim()) ? [permissions] : [];
  if (typeof permissions !== "object") return [String(permissions)];
  return Object.entries(permissions)
    .filter(([, value]) => typeof value === "string" && value.trim().toLowerCase() === "write")
    .map(([scope]) => scope);
}

function checkUses(name, where, target, problems) {
  if (typeof target !== "string") {
    problems.push(`${name}: ${where}: 'uses' no es una cadena.`);
    return;
  }
  if (target.startsWith("./")) return;
  if (target.startsWith("docker://")) {
    if (!DOCKER_DIGEST.test(target)) problems.push(`${name}: ${where}: '${target}' no está fijada por digest sha256.`);
    return;
  }
  if (!SHA_PIN.test(target)) problems.push(`${name}: ${where}: '${target}' no está fijada por SHA de 40 caracteres.`);
}

/** Devuelve la lista de incumplimientos de un workflow (vacía si cumple). */
export function checkWorkflow(name, text) {
  const problems = [];
  let doc;
  try {
    doc = parse(text, { prettyErrors: false });
  } catch (error) {
    return [`${name}: no se puede leer como YAML (${String(error.message).split("\n")[0]}).`];
  }
  if (doc === null || typeof doc !== "object") return [`${name}: el workflow está vacío o no es un mapa YAML.`];

  if (!("permissions" in doc)) {
    problems.push(`${name}: falta el bloque 'permissions:' en el nivel más alto (p. ej. 'permissions:\\n  contents: read').`);
  } else if (writePermissions(doc.permissions).length > 0) {
    problems.push(`${name}: 'permissions:' global concede escritura; déjala en solo lectura y concede la escritura dentro del job que la necesita.`);
  }

  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    if (job === null || typeof job !== "object") continue;
    if (typeof job.permissions === "string" && /^write-all$/i.test(job.permissions.trim())) {
      problems.push(`${name}: job '${jobName}' usa 'permissions: write-all'; concede solo los permisos concretos que necesita.`);
    }
    if ("uses" in job) checkUses(name, `job '${jobName}'`, job.uses, problems);
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, index) => {
      if (step !== null && typeof step === "object" && "uses" in step) {
        checkUses(name, `job '${jobName}', paso ${index + 1}`, step.uses, problems);
      }
    });
  }
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
  console.log(`${files.length} workflow(s) cumplen: permissions global de solo lectura, sin write-all y acciones fijadas por SHA.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
