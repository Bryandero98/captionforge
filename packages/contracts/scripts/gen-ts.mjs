// Genera los tipos TypeScript desde los JSON Schema: generated/ts/<esquema>.ts + index.ts.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile } from "json-schema-to-typescript";

import { SCHEMAS_DIR, isMain, messageSchemaNames, outDirFromArgs, readSchema } from "./lib.mjs";

const BANNER = [
  "/* eslint-disable */",
  "/**",
  " * AUTO-GENERADO desde packages/contracts/schemas. NO EDITAR A MANO.",
  " * Regenerar con: npm run contracts:gen",
  " */",
].join("\n");

const lf = (text) => text.replace(/\r\n/g, "\n");

export async function generateTs(outDir) {
  const tsDir = join(outDir, "ts");
  rmSync(tsDir, { recursive: true, force: true });
  mkdirSync(tsDir, { recursive: true });

  const exports = [];
  for (const name of messageSchemaNames()) {
    const schema = readSchema(name);
    // Se quita $id: las referencias relativas ("common.v1.json#/...") deben resolverse contra
    // la carpeta local de esquemas, no contra la URL lógica del $id.
    const { $id, ...withoutId } = schema;
    const ts = await compile(withoutId, schema.title, {
      cwd: SCHEMAS_DIR + "/",
      bannerComment: BANNER,
      declareExternallyReferenced: true,
      additionalProperties: false,
      strictIndexSignatures: true,
      style: { singleQuote: false, semi: true, printWidth: 100 },
    });
    writeFileSync(join(tsDir, `${name}.ts`), lf(ts));
    exports.push(`export type { ${schema.title} } from "./${name}";`);
  }

  writeFileSync(join(tsDir, "index.ts"), lf([BANNER, "", ...exports, ""].join("\n")));
  return tsDir;
}

if (isMain(import.meta.url)) {
  const dir = await generateTs(outDirFromArgs());
  console.log(`TypeScript generado en ${dir}`);
}
