import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEFAULT_TENANT_ID, displayPrefix, hashApiKey } from "./api-key.js";

export const DEFAULT_KEY_NAME = "default";
export const MIN_SEED_KEY_LENGTH = 32;

/**
 * Deja en la base la clave por defecto del tenant "Default" (la que usa la interfaz web local, ver ADR 0015).
 * Es idempotente: repetirla no duplica nada, y cambiar `DEFAULT_API_KEY` en el .env rota la clave (la anterior
 * llamada "default" queda revocada). Corre con el dueño del esquema (cf_owner): cf_api no puede crear claves.
 */
export async function seedDefaultKey(client: pg.ClientBase, key: string): Promise<"created" | "unchanged"> {
  if (key.length < MIN_SEED_KEY_LENGTH) {
    throw new Error(`DEFAULT_API_KEY debe tener al menos ${MIN_SEED_KEY_LENGTH} caracteres (la genera start.sh / start.bat, o: openssl rand -hex 32).`);
  }
  const hash = hashApiKey(key);
  await client.query(`INSERT INTO "Tenant" ("id", "name") VALUES ($1, 'Default') ON CONFLICT ("id") DO NOTHING`, [DEFAULT_TENANT_ID]);
  const inserted = await client.query(
    `INSERT INTO "ApiKey" ("id", "tenantId", "name", "prefix", "keyHash") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("keyHash") DO NOTHING`,
    [randomUUID(), DEFAULT_TENANT_ID, DEFAULT_KEY_NAME, displayPrefix(key), hash],
  );
  // Si la clave estaba revocada a mano y vuelve a ponerse en el .env, se entiende que se quiere activa.
  await client.query(`UPDATE "ApiKey" SET "revokedAt" = NULL WHERE "keyHash" = $1 AND "revokedAt" IS NOT NULL`, [hash]);
  await client.query(
    `UPDATE "ApiKey" SET "revokedAt" = now() WHERE "tenantId" = $1 AND "name" = $2 AND "keyHash" <> $3 AND "revokedAt" IS NULL`,
    [DEFAULT_TENANT_ID, DEFAULT_KEY_NAME, hash],
  );
  return inserted.rowCount === 1 ? "created" : "unchanged";
}

async function main(): Promise<void> {
  const key = process.env.DEFAULT_API_KEY;
  if (!key) {
    console.log("DEFAULT_API_KEY no está definida: no se crea ninguna clave por defecto.");
    return;
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await seedDefaultKey(client, key);
    await client.query("COMMIT");
    console.log(result === "created" ? "Clave por defecto creada." : "La clave por defecto ya existía.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
