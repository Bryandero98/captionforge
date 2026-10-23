// Tenants y claves de API de prueba. Se crean con el rol DUEÑO (cf_owner): el API en ejecución (cf_api) no puede
// crear tenants ni claves, y las pruebas no deben darle ese permiso.
import { randomUUID } from "node:crypto";

import pg from "pg";

import { displayPrefix, generateApiKey, hashApiKey } from "../../src/tenancy/api-key.js";

export interface TestTenant {
  id: string;
  name: string;
  apiKey: string;
  /** Cabecera lista para fetch / http.request. */
  headers: { "x-api-key": string };
}

const createdTenants: string[] = [];
let owner: pg.Pool | undefined;

function pool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error("Falta DATABASE_URL_OWNER (npm test lo define con scripts/with-env.mjs).");
  owner ??= new pg.Pool({ connectionString, max: 2 });
  return owner;
}

export async function createTestTenant(label = "prueba"): Promise<TestTenant> {
  const id = randomUUID();
  const name = `${label}-${id.slice(0, 8)}`;
  const apiKey = generateApiKey();
  await pool().query(`INSERT INTO "Tenant" ("id", "name") VALUES ($1, $2)`, [id, name]);
  createdTenants.push(id);
  await addApiKey(id, apiKey, "prueba");
  return { id, name, apiKey, headers: { "x-api-key": apiKey } };
}

/** Otra clave para un tenant que ya existe (p. ej. para probar la revocación). Devuelve el id de la clave. */
export async function addApiKey(tenantId: string, apiKey: string, name = "extra"): Promise<string> {
  const id = randomUUID();
  await pool().query(`INSERT INTO "ApiKey" ("id", "tenantId", "name", "prefix", "keyHash") VALUES ($1, $2, $3, $4, $5)`, [
    id,
    tenantId,
    name,
    displayPrefix(apiKey),
    hashApiKey(apiKey),
  ]);
  return id;
}

export async function revokeApiKey(id: string): Promise<void> {
  await pool().query(`UPDATE "ApiKey" SET "revokedAt" = now() WHERE "id" = $1`, [id]);
}

/** Borra los tenants creados (con sus trabajos y claves) y cierra la conexión. Llamar desde afterAll. */
export async function disposeTestTenants(): Promise<void> {
  restoreFetch();
  shared = undefined;
  if (owner === undefined) return;
  for (const id of createdTenants.splice(0)) {
    await pool().query(`DELETE FROM "Job" WHERE "tenantId" = $1`, [id]);
    await pool().query(`DELETE FROM "ApiKey" WHERE "tenantId" = $1`, [id]);
    await pool().query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [id]);
    await pool().query(`DELETE FROM "User" WHERE "tenantId" = $1`, [id]);
    await pool().query(`DELETE FROM "Tenant" WHERE "id" = $1`, [id]);
  }
  await owner.end();
  owner = undefined;
}

const realFetch = globalThis.fetch;

/**
 * Hace que `fetch` envíe `X-API-Key` en cada petición que no la traiga ya. Es para las pruebas heredadas, que
 * llamaban al API sin autenticación: así se conservan tal cual y solo se prueba el aislamiento donde importa.
 */
export function authenticateFetch(apiKey: string): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(source);
    if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
    return input instanceof Request ? realFetch(new Request(input, { ...init, headers })) : realFetch(input, { ...init, headers });
  }) as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

let shared: Promise<TestTenant> | undefined;

/**
 * El tenant de la prueba heredada: se crea una vez por archivo y deja `fetch` autenticado con su clave.
 * `disposeTestTenants` (afterAll) lo borra y restaura `fetch`.
 */
export function sharedTenant(): Promise<TestTenant> {
  shared ??= createTestTenant("compartido").then((tenant) => {
    authenticateFetch(tenant.apiKey);
    return tenant;
  });
  return shared;
}
