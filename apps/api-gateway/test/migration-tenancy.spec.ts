// La migración de tenencia sobre una base CON trabajos ya guardados (ADR 0015). Se prueba en un esquema temporal dentro
// de una transacción que siempre se deshace: no toca los datos reales. Rol dueño (cf_owner), que puede crear esquemas.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_TENANT_ID } from "../src/tenancy/api-key.js";

const MIGRATIONS = join(import.meta.dirname, "..", "prisma", "migrations");
const migration = (suffix: string): string => {
  const folder = readdirSync(MIGRATIONS).find((name) => name.endsWith(`_${suffix}`));
  if (!folder) throw new Error(`No encuentro la migración *_${suffix}`);
  return readFileSync(join(MIGRATIONS, folder, "migration.sql"), "utf-8");
};

let owner: pg.Client;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error("Falta DATABASE_URL_OWNER: ejecuta las pruebas con scripts/with-env.mjs");
  owner = new pg.Client({ connectionString });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

/** Corre `body` en un esquema vacío con la migración inicial aplicada y dos trabajos "antiguos"; siempre deshace. */
async function onLegacyDatabase<T>(body: (jobIds: string[]) => Promise<T>): Promise<T> {
  const schema = `tmp_tenancy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await owner.query("BEGIN");
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    await owner.query(`SET LOCAL search_path TO ${schema}`);
    // La migración inicial toca "_prisma_migrations" por nombre sin esquema; en el esquema temporal hace falta una de mentira.
    await owner.query(`CREATE TABLE "_prisma_migrations" (id int)`);
    await owner.query(migration("init"));
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      await owner.query(
        `INSERT INTO "Job" (id, kind, "inputBucket", "inputKey", "originalFilename", "contentType", "sizeBytes", "outputPrefix", options, "updatedAt")
         VALUES ($1, 'TRANSCRIBE', 'b', 'k', 'f.mp4', 'video/mp4', 1, 'jobs/x/out/', '{}', now())`,
        [id],
      );
    }
    return await body(ids);
  } finally {
    await owner.query("ROLLBACK");
  }
}

describe("migración de tenencia", () => {
  it("rojo: añadir la columna NOT NULL de golpe falla en una base con trabajos (por eso el relleno va antes)", async () => {
    await onLegacyDatabase(async () => {
      await owner.query("SAVEPOINT intento");
      await expect(owner.query(`ALTER TABLE "Job" ADD COLUMN "tenantId" UUID NOT NULL`)).rejects.toMatchObject({ code: "23502" });
      await owner.query("ROLLBACK TO SAVEPOINT intento");
    });
  });

  it("verde: crea el tenant por defecto, le asigna los trabajos existentes y deja la columna NOT NULL", async () => {
    await onLegacyDatabase(async (ids) => {
      await owner.query(migration("tenancy"));

      const tenants = await owner.query<{ id: string; name: string }>(`SELECT id, name FROM "Tenant"`);
      expect(tenants.rows).toEqual([{ id: DEFAULT_TENANT_ID, name: "Default" }]);

      const jobs = await owner.query<{ id: string; tenantId: string }>(`SELECT id, "tenantId" FROM "Job" ORDER BY id`);
      expect(jobs.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
      expect(jobs.rows.every((row) => row.tenantId === DEFAULT_TENANT_ID)).toBe(true);

      const column = await owner.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Job' AND column_name = 'tenantId'`,
      );
      expect(column.rows[0]!.is_nullable).toBe("NO");

      // Y ya no admite trabajos sin tenant ni de un tenant que no existe.
      await owner.query("SAVEPOINT sin_tenant");
      await expect(
        owner.query(
          `INSERT INTO "Job" (id, kind, "inputBucket", "inputKey", "originalFilename", "contentType", "sizeBytes", "outputPrefix", options, "updatedAt")
           VALUES ($1, 'TRANSCRIBE', 'b', 'k', 'f.mp4', 'video/mp4', 1, 'jobs/x/out/', '{}', now())`,
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23502" });
      await owner.query("ROLLBACK TO SAVEPOINT sin_tenant");
      await owner.query("SAVEPOINT tenant_falso");
      await expect(
        owner.query(
          `INSERT INTO "Job" (id, "tenantId", kind, "inputBucket", "inputKey", "originalFilename", "contentType", "sizeBytes", "outputPrefix", options, "updatedAt")
           VALUES ($1, $2, 'TRANSCRIBE', 'b', 'k', 'f.mp4', 'video/mp4', 1, 'jobs/x/out/', '{}', now())`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await owner.query("ROLLBACK TO SAVEPOINT tenant_falso");
    });
  });

  it("no se puede borrar un tenant que tiene trabajos (ON DELETE RESTRICT)", async () => {
    await onLegacyDatabase(async () => {
      await owner.query(migration("tenancy"));
      await expect(owner.query(`DELETE FROM "Tenant" WHERE id = $1`, [DEFAULT_TENANT_ID])).rejects.toMatchObject({ code: "23503" });
    });
  });
});
