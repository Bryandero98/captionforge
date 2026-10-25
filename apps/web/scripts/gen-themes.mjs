// Genera public/js/domain/themes-data.js desde packages/contracts/themes.v1.json (la fuente única de verdad de los temas).
// La interfaz se sirve sin compilar, así que no puede importar el contrato en tiempo de ejecución: se copia al construirla.
//
//   node scripts/gen-themes.mjs          escribe el archivo
//   node scripts/gen-themes.mjs --check  falla si el archivo generado no coincide (para CI)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "..", "..", "packages", "contracts", "themes.v1.json");
const TARGET = join(HERE, "..", "public", "js", "domain", "themes-data.js");

function render() {
  const catalogue = JSON.parse(readFileSync(SOURCE, "utf8"));
  return (
    "// GENERADO por scripts/gen-themes.mjs desde packages/contracts/themes.v1.json. No editar a mano.\n" +
    "// Los números de `preview` los comprueba contra el motor real python-tests/test_themes_parity.py.\n\n" +
    `export const THEMES_DEFAULT_ID = ${JSON.stringify(catalogue.default)};\n\n` +
    `/** @type {readonly import("./themes.js").ThemeData[]} */\n` +
    `export const THEMES_DATA = ${JSON.stringify(catalogue.themes, null, 2)};\n`
  );
}

const text = render();
if (process.argv.includes("--check")) {
  if (!existsSync(TARGET) || readFileSync(TARGET, "utf8") !== text) {
    console.error("themes-data.js no coincide con themes.v1.json: ejecuta `node apps/web/scripts/gen-themes.mjs`");
    process.exit(1);
  }
  console.log("themes-data.js al día");
} else {
  writeFileSync(TARGET, text, { encoding: "utf8" });
  console.log(`escrito ${TARGET}`);
}
