import { createRequire } from "node:module";

import type { ValidateFunction } from "ajv/dist/2020.js";
import type Ajv2020Type from "ajv/dist/2020.js";

// ajv y ajv-formats son CommonJS: con require se obtiene la clase/función real sin depender de cómo
// TypeScript modele el "default" en ESM. Los esquemas se leen como JSON desde el paquete de
// contratos (campo "exports" de su package.json).
const require = createRequire(import.meta.url);
// Con resolución node16 el import por defecto de un módulo CommonJS es el módulo entero: la clase está en .default.
type Ajv2020Class = (typeof Ajv2020Type)["default"];
const Ajv2020 = require("ajv/dist/2020") as Ajv2020Class;
const addFormats = require("ajv-formats") as (ajv: InstanceType<Ajv2020Class>) => unknown;
const schemaFile = (name: string): object => require(`@captionforge/contracts/schemas/${name}.json`) as object;

const SCHEMA_FILES = [
  "common.v1",
  "burn-job.v1",
  "burn-result.v1",
  "cancel-message.v1",
  "job-error.v1",
  "job-progress.v1",
  "transcribe-job.v1",
  "transcribe-result.v1",
] as const;

export type ContractName =
  | "burn-job.v1"
  | "burn-result.v1"
  | "cancel-message.v1"
  | "job-error.v1"
  | "job-progress.v1"
  | "transcribe-job.v1"
  | "transcribe-result.v1";

export class ContractViolation extends Error {
  constructor(
    readonly contract: ContractName,
    readonly details: string,
  ) {
    super(`El mensaje no cumple el contrato ${contract}: ${details}`);
  }
}

// Los MISMOS esquemas que valida el worker en Python con Pydantic estricto (ADR 0001).
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const name of SCHEMA_FILES) ajv.addSchema(schemaFile(name));

const cache = new Map<ContractName, ValidateFunction>();

/** Lanza ContractViolation si `data` no cumple el contrato; si cumple, no hace nada. */
export function assertContract(name: ContractName, data: unknown): void {
  let validate = cache.get(name);
  if (!validate) {
    validate = ajv.getSchema(`https://captionforge.dev/schemas/${name}.json`);
    if (!validate) throw new Error(`Esquema desconocido: ${name}`);
    cache.set(name, validate);
  }
  if (!validate(data)) throw new ContractViolation(name, ajv.errorsText(validate.errors));
}
