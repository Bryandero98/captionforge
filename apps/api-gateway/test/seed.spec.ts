// La semilla de la clave por defecto (ADR 0015) contra la base real, dentro de una transacción que siempre se deshace.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_TENANT_ID, generateApiKey, hashApiKey } from "../src/tenancy/api-key.js";
import { DEFAULT_KEY_NAME, seedDefaultKey } from "../src/tenancy/seed.js";

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

async function inTransaction(body: () => Promise<void>): Promise<void> {
  await owner.query("BEGIN");
  try {
    await body();
  } finally {
    await owner.query("ROLLBACK");
  }
}

const state = async (key: string): Promise<{ tenantId: string; name: string; revoked: boolean } | undefined> => {
  const { rows } = await owner.query<{ tenantId: string; name: string; revoked: boolean }>(
    `SELECT "tenantId", name, "revokedAt" IS NOT NULL AS revoked FROM "ApiKey" WHERE "keyHash" = $1`,
    [hashApiKey(key)],
  );
  return rows[0];
};

describe("seedDefaultKey", () => {
  it("da de alta la clave en el tenant Default, guardando solo su hash, y es idempotente", async () => {
    await inTransaction(async () => {
      const key = generateApiKey();
      expect(await seedDefaultKey(owner, key)).toBe("created");
      expect(await state(key)).toEqual({ tenantId: DEFAULT_TENANT_ID, name: DEFAULT_KEY_NAME, revoked: false });
      const stored = await owner.query(`SELECT prefix, "keyHash" FROM "ApiKey" WHERE "keyHash" = $1`, [hashApiKey(key)]);
      expect(stored.rows[0]).toEqual({ prefix: key.slice(0, 8), keyHash: hashApiKey(key) });
      expect(JSON.stringify(stored.rows)).not.toContain(key);

      expect(await seedDefaultKey(owner, key)).toBe("unchanged");
      const count = await owner.query(`SELECT count(*)::int AS n FROM "ApiKey" WHERE "keyHash" = $1`, [hashApiKey(key)]);
      expect(count.rows[0].n).toBe(1);
    });
  });

  it("rotar DEFAULT_API_KEY revoca la anterior y volver a la vieja la reactiva", async () => {
    await inTransaction(async () => {
      const first = generateApiKey();
      const second = generateApiKey();
      await seedDefaultKey(owner, first);
      await seedDefaultKey(owner, second);
      expect((await state(first))!.revoked).toBe(true);
      expect((await state(second))!.revoked).toBe(false);

      await seedDefaultKey(owner, first);
      expect((await state(first))!.revoked).toBe(false);
      expect((await state(second))!.revoked).toBe(true);
    });
  });

  it("no toca las claves de otros tenants ni las que no se llaman «default»", async () => {
    await inTransaction(async () => {
      await owner.query(`INSERT INTO "Tenant" (id, name) VALUES ('00000000-0000-4000-8000-0000000000aa', 'otro')`);
      const foreign = generateApiKey();
      const named = generateApiKey();
      await owner.query(`INSERT INTO "ApiKey" (id, "tenantId", name, prefix, "keyHash") VALUES (gen_random_uuid(), '00000000-0000-4000-8000-0000000000aa', 'default', 'x', $1)`, [hashApiKey(foreign)]);
      await owner.query(`INSERT INTO "ApiKey" (id, "tenantId", name, prefix, "keyHash") VALUES (gen_random_uuid(), $2, 'manual', 'x', $1)`, [hashApiKey(named), DEFAULT_TENANT_ID]);

      await seedDefaultKey(owner, generateApiKey());
      expect((await state(foreign))!.revoked).toBe(false);
      expect((await state(named))!.revoked).toBe(false);
    });
  });

  it("rechaza una clave corta", async () => {
    await expect(seedDefaultKey(owner, "corta")).rejects.toThrow(/DEFAULT_API_KEY/);
  });
});
