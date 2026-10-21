// Pruebas de la comprobación de workflows (H9) y, al final, la comprobación contra los workflows reales.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkWorkflow } from "./check-workflows.mjs";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const wf = (extra) => `name: X\non: push\n${extra}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;

test("exige un bloque permissions en el nivel más alto", () => {
  const problems = checkWorkflow("x.yml", wf(""));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /permissions/);
});

test("acepta permissions con solo lectura o vacío", () => {
  assert.deepEqual(checkWorkflow("x.yml", wf("permissions:\n  contents: read\n")), []);
  assert.deepEqual(checkWorkflow("x.yml", wf("permissions: {}\n")), []);
});

test("rechaza escritura en el nivel más alto, pero la permite dentro de un job", () => {
  assert.equal(checkWorkflow("x.yml", wf("permissions:\n  contents: write\n")).length, 1);
  assert.equal(checkWorkflow("x.yml", wf("permissions: write-all\n")).length, 1);
  const jobLevel = `name: X\non: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: echo\n`;
  assert.deepEqual(checkWorkflow("x.yml", jobLevel), []);
});

test("un permissions de un job no cuenta como global", () => {
  const onlyJob = `name: X\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - run: echo\n`;
  assert.equal(checkWorkflow("x.yml", onlyJob).length, 1);
});

test("exige acciones fijadas por SHA completo (se admiten acciones locales y comentarios)", () => {
  const base = "permissions:\n  contents: read\n";
  const step = (uses) => wf(base).replace("      - run: echo", `      - uses: ${uses}\n      - run: echo`);
  assert.equal(checkWorkflow("x.yml", step("actions/checkout@v4")).length, 1);
  assert.equal(checkWorkflow("x.yml", step("pypa/gh-action-pypi-publish@release/v1")).length, 1);
  assert.equal(checkWorkflow("x.yml", step(`actions/checkout@${SHA.slice(0, 7)}`)).length, 1);
  assert.deepEqual(checkWorkflow("x.yml", step(`actions/checkout@${SHA} # v4`)), []);
  assert.deepEqual(checkWorkflow("x.yml", step("./.github/actions/local")), []);
});

test("los workflows reales cumplen (permissions global de solo lectura y acciones fijadas por SHA)", () => {
  const folder = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  const files = readdirSync(folder).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 3, "se esperaban al menos 3 workflows");
  const problems = files.flatMap((name) => checkWorkflow(name, readFileSync(folder + name, "utf8")));
  assert.deepEqual(problems, []);
});
