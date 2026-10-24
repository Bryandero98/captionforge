// Pruebas del contrato desde el lado Node (Ajv, modo estricto).
// El lado Python usa los MISMOS ejemplos (python-tests/): si los dos aceptan y rechazan lo
// mismo, NestJS y el worker no pueden discrepar sobre qué es un mensaje válido.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { EXAMPLES_DIR, SCHEMAS_DIR, messageSchemaNames, readSchema } from "../scripts/lib.mjs";

function buildAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMAS_DIR).filter((x) => x.endsWith(".json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, f), "utf8")));
  }
  return ajv;
}

function examples(kind) {
  const dir = join(EXAMPLES_DIR, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      // "transcribe-job.v1.basic.json" -> esquema "transcribe-job.v1"
      schema: f.split(".").slice(0, 2).join("."),
      body: JSON.parse(readFileSync(join(dir, f), "utf8")),
    }));
}

const ajv = buildAjv();
const names = messageSchemaNames();

test("todos los esquemas compilan en modo estricto", () => {
  assert.ok(names.length >= 7, `se esperaban al menos 7 esquemas de mensaje, hay ${names.length}`);
  for (const name of names) {
    const schema = readSchema(name);
    assert.ok(ajv.getSchema(schema.$id), `no compila: ${name}`);
  }
});

for (const { file, schema, body } of examples("valid")) {
  test(`válido: ${file}`, () => {
    assert.ok(names.includes(schema), `ejemplo sin esquema: ${schema}`);
    const validate = ajv.getSchema(readSchema(schema).$id);
    assert.ok(validate(body), JSON.stringify(validate.errors));
  });
}

for (const { file, schema, body } of examples("invalid")) {
  test(`inválido: ${file}`, () => {
    assert.ok(names.includes(schema), `ejemplo sin esquema: ${schema}`);
    const validate = ajv.getSchema(readSchema(schema).$id);
    assert.equal(validate(body), false, "se esperaba rechazo y se aceptó");
  });
}

test("cada esquema de mensaje tiene al menos un ejemplo válido y uno inválido", () => {
  const ok = new Set(examples("valid").map((e) => e.schema));
  const bad = new Set(examples("invalid").map((e) => e.schema));
  for (const name of names) {
    assert.ok(ok.has(name), `falta ejemplo válido de ${name}`);
    assert.ok(bad.has(name), `falta ejemplo inválido de ${name}`);
  }
});

test("un jobId distinto del de la clave sigue siendo válido para el esquema (se comprueba en código)", () => {
  // JSON Schema no puede cruzar campos: la coincidencia jobId <-> jobs/<jobId>/ la verifica el
  // productor y el worker. Este test documenta ese límite para que nadie lo dé por cubierto.
  const validate = ajv.getSchema(readSchema("transcribe-job.v1").$id);
  const body = JSON.parse(
    readFileSync(join(EXAMPLES_DIR, "valid", "transcribe-job.v1.basic.json"), "utf8"),
  );
  body.jobId = "11111111-2222-4333-8444-555555555555";
  assert.ok(validate(body));
});

// ADR 0020: un mensaje de la cola (visible en Redis) jamás puede llevar una clave externa ni texto crudo de un proveedor.
function* objectSchemas(node, path) {
  if (node === null || typeof node !== "object") return;
  if (node.type === "object") yield { path, node };
  for (const [key, child] of Object.entries(node.properties ?? {})) yield* objectSchemas(child, `${path}.${key}`);
  for (const [key, child] of Object.entries(node.$defs ?? {})) yield* objectSchemas(child, `${path}.$defs.${key}`);
  if (node.items) yield* objectSchemas(node.items, `${path}[]`);
}

for (const name of ["translate-job.v1", "translate-result.v1", "dub-job.v1", "dub-result.v1"]) {
  test(`${name}: cada objeto cierra sus propiedades y ningún campo puede llevar una clave`, () => {
    const schema = readSchema(name);
    let seen = 0;
    for (const { path, node } of objectSchemas(schema, name)) {
      seen += 1;
      assert.equal(node.additionalProperties, false, `${path} debe declarar additionalProperties:false`);
      for (const field of Object.keys(node.properties ?? {})) {
        // objectKey/ObjectKey son rutas de S3; cualquier otro nombre con key/secret/token/password/auth es sospechoso.
        assert.doesNotMatch(field, /^(?!objectKey$)(.*(api.?key|secret|token|password|credential|authorization).*)$/i, `${path}.${field}`);
      }
    }
    assert.ok(seen >= 2, "se esperaban varios objetos en el esquema");
  });
}
