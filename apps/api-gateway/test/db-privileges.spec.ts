// Comprueba, contra la base REAL ya migrada, que cada rol puede lo que debe y nada más (ADR 0003).
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name}: ejecuta las pruebas con scripts/with-env.mjs`);
  return value;
};

const owner = new pg.Client({ connectionString: url("DATABASE_URL_OWNER") });
const api = new pg.Client({ connectionString: url("DATABASE_URL_API") });
const worker = new pg.Client({ connectionString: url("DATABASE_URL_WORKER") });
const id = randomUUID();

const DEFAULT_TENANT = "00000000-0000-4000-8000-000000000001"; // lo crea la migración de tenencia
const insert = `INSERT INTO "Job" (id, "tenantId", kind, "inputBucket", "inputKey", "originalFilename", "contentType",
  "sizeBytes", "outputPrefix", options, "updatedAt")
  VALUES ($1, '${DEFAULT_TENANT}', 'TRANSCRIBE', 'b', 'k', 'f.mp4', 'video/mp4', 1, 'jobs/x/out/', '{}', now())`;

beforeAll(async () => {
  await Promise.all([owner.connect(), api.connect(), worker.connect()]);
  await api.query(insert, [id]);
});

afterAll(async () => {
  await api.query(`DELETE FROM "Job" WHERE id = $1`, [id]);
  await Promise.all([owner.end(), api.end(), worker.end()]);
});

describe("cf_worker (solo lee y actualiza columnas concretas)", () => {
  it("lee trabajos", async () => {
    const r = await worker.query(`SELECT status FROM "Job" WHERE id = $1`, [id]);
    expect(r.rows[0].status).toBe("QUEUED");
  });

  it("actualiza estado, progreso y resultado", async () => {
    await worker.query(
      `UPDATE "Job" SET status = 'RUNNING', stage = 'transcribing', percent = 42, message = 'm',
        result = '{"a":1}', "startedAt" = now(), "updatedAt" = now() WHERE id = $1`,
      [id],
    );
    const r = await worker.query(`SELECT status, percent FROM "Job" WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ status: "RUNNING", percent: 42 });
  });

  it.each(["originalFilename", "inputKey", "inputBucket", "outputPrefix", "kind"])(
    "NO puede modificar la columna %s",
    async (column) => {
      const value = column === "kind" ? `'BURN'` : `'x'`;
      await expect(worker.query(`UPDATE "Job" SET "${column}" = ${value} WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
    },
  );

  it("NO puede insertar ni borrar trabajos", async () => {
    await expect(worker.query(insert, [randomUUID()])).rejects.toThrow(/permission denied/);
    await expect(worker.query(`DELETE FROM "Job" WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
  });

  it("NO puede ver el historial de migraciones", async () => {
    await expect(worker.query(`SELECT * FROM "_prisma_migrations"`)).rejects.toThrow(/permission denied/);
  });
});

describe("cf_api (datos sí, esquema no)", () => {
  it("inserta, lee, actualiza y borra trabajos", async () => {
    const other = randomUUID();
    await api.query(insert, [other]);
    await api.query(`UPDATE "Job" SET message = 'hola' WHERE id = $1`, [other]);
    expect((await api.query(`SELECT message FROM "Job" WHERE id = $1`, [other])).rows[0].message).toBe("hola");
    await api.query(`DELETE FROM "Job" WHERE id = $1`, [other]);
  });

  it("NO puede alterar el esquema ni el historial de migraciones", async () => {
    await expect(api.query(`ALTER TABLE "Job" ADD COLUMN x int`)).rejects.toThrow(/must be owner/);
    await expect(api.query(`DROP TABLE "Job"`)).rejects.toThrow(/must be owner/);
    await expect(api.query(`SELECT * FROM "_prisma_migrations"`)).rejects.toThrow(/permission denied/);
    await expect(api.query(`DELETE FROM "_prisma_migrations"`)).rejects.toThrow(/permission denied/);
  });
});

describe("cf_owner (dueño del esquema, sin superusuario)", () => {
  it("ve el historial de migraciones y la migración init está aplicada", async () => {
    const r = await owner.query(`SELECT migration_name, finished_at IS NOT NULL AS ok FROM "_prisma_migrations"`);
    expect(r.rows.map((x: { migration_name: string }) => x.migration_name)).toContain("20261021000000_init");
    expect(r.rows.every((x: { ok: boolean }) => x.ok)).toBe(true);
  });
});

describe("tablas de tenencia y sesiones (ADR 0015 y 0016)", () => {
  const tenantRow = randomUUID();
  const userRow = randomUUID();
  const keyRow = randomUUID();
  const keyHash = randomUUID().replaceAll("-", "");

  beforeAll(async () => {
    await owner.query(`INSERT INTO "Tenant" (id, name) VALUES ($1, 'privilegios')`, [tenantRow]);
    await owner.query(`INSERT INTO "User" (id, "tenantId", provider, subject) VALUES ($1, $2, 'github', $3)`, [userRow, tenantRow, `priv-${userRow}`]);
    await owner.query(`INSERT INTO "ApiKey" (id, "tenantId", name, prefix, "keyHash") VALUES ($1, $2, 'k', 'cfk_0000', $3)`, [keyRow, tenantRow, keyHash]);
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM "Session" WHERE "userId" = $1`, [userRow]);
    await owner.query(`DELETE FROM "ApiKey" WHERE "tenantId" = $1`, [tenantRow]);
    await owner.query(`DELETE FROM "User" WHERE "tenantId" = $1`, [tenantRow]);
    await owner.query(`DELETE FROM "Tenant" WHERE id = $1`, [tenantRow]);
  });

  it("cf_api crea lo que necesita el inicio de sesión: tenants, personas, sesiones y claves", async () => {
    const tenant = randomUUID();
    const user = randomUUID();
    await api.query(`INSERT INTO "Tenant" (id, name) VALUES ($1, 'nuevo')`, [tenant]);
    await api.query(`INSERT INTO "User" (id, "tenantId", provider, subject) VALUES ($1, $2, 'github', $3)`, [user, tenant, `priv-${user}`]);
    await api.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [randomUUID(), user, randomUUID()]);
    await api.query(`INSERT INTO "ApiKey" (id, "tenantId", name, prefix, "keyHash") VALUES ($1, $2, 'k', 'p', $3)`, [randomUUID(), tenant, randomUUID()]);
    await api.query(`DELETE FROM "Session" WHERE "userId" = $1`, [user]); // cerrar sesión
    // Limpieza con el dueño (el API no puede borrar nada de esto).
    await owner.query(`DELETE FROM "ApiKey" WHERE "tenantId" = $1`, [tenant]);
    await owner.query(`DELETE FROM "User" WHERE id = $1`, [user]);
    await owner.query(`DELETE FROM "Tenant" WHERE id = $1`, [tenant]);
  });

  it("membresías (ADR 0019): cf_api las lee, las crea, cambia el ROL y las borra, pero no reescribe a quién pertenecen; cf_worker no las ve", async () => {
    await api.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, 'OWNER')`, [userRow, tenantRow]);
    expect((await api.query(`SELECT role::text AS role FROM "Membership" WHERE "userId" = $1`, [userRow])).rows).toEqual([{ role: "OWNER" }]);
    await api.query(`UPDATE "Membership" SET role = 'VIEWER' WHERE "userId" = $1`, [userRow]);
    for (const column of ["userId", "tenantId"]) {
      await expect(api.query(`UPDATE "Membership" SET "${column}" = $2 WHERE "userId" = $1`, [userRow, randomUUID()]), column).rejects.toThrow(/permission denied/);
    }
    await api.query(`DELETE FROM "Membership" WHERE "userId" = $1`, [userRow]);
    await expect(worker.query(`SELECT 1 FROM "Membership"`)).rejects.toThrow(/permission denied/);
  });

  it("invitaciones: cf_api crea, lee y marca aceptada o revocada; no borra ni reescribe el token, el rol o el espacio; cf_worker no las ve", async () => {
    const invitation = randomUUID();
    await api.query(`INSERT INTO "Invitation" (id, "tenantId", role, "tokenHash", "createdBy", "expiresAt") VALUES ($1, $2, 'VIEWER', $3, $4, now() + interval '7 days')`, [invitation, tenantRow, randomUUID(), userRow]);
    await api.query(`UPDATE "Invitation" SET "acceptedAt" = now(), "acceptedBy" = $2 WHERE id = $1`, [invitation, userRow]);
    await api.query(`UPDATE "Invitation" SET "revokedAt" = now() WHERE id = $1`, [invitation]);
    for (const column of ["tokenHash", "role", "tenantId", "expiresAt", "createdBy"]) {
      const value = column === "role" ? `'OWNER'::"Role"` : column === "expiresAt" ? "now()" : column === "tenantId" || column === "createdBy" ? `'${randomUUID()}'` : `'x'`;
      await expect(api.query(`UPDATE "Invitation" SET "${column}" = ${value} WHERE id = $1`, [invitation]), column).rejects.toThrow(/permission denied/);
    }
    await expect(api.query(`DELETE FROM "Invitation" WHERE id = $1`, [invitation])).rejects.toThrow(/permission denied/);
    await expect(worker.query(`SELECT 1 FROM "Invitation"`)).rejects.toThrow(/permission denied/);
    await owner.query(`DELETE FROM "Invitation" WHERE id = $1`, [invitation]);
  });

  it("sesión: cf_api solo cambia el espacio activo, no a quién pertenece", async () => {
    const session = randomUUID();
    await api.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [session, userRow, randomUUID()]);
    await api.query(`UPDATE "Session" SET "tenantId" = $2 WHERE id = $1`, [session, tenantRow]);
    await expect(api.query(`UPDATE "Session" SET "userId" = $2 WHERE id = $1`, [session, randomUUID()])).rejects.toThrow(/permission denied/);
    await api.query(`DELETE FROM "Session" WHERE id = $1`, [session]);
  });

  it("cf_api solo cambia ApiKey.lastUsedAt y ApiKey.revokedAt: no el hash, ni el dueño, ni el nombre", async () => {
    await api.query(`UPDATE "ApiKey" SET "lastUsedAt" = now() WHERE id = $1`, [keyRow]);
    await api.query(`UPDATE "ApiKey" SET "revokedAt" = now() WHERE id = $1`, [keyRow]);
    for (const column of ["keyHash", "tenantId", "name", "prefix"]) {
      const value = column === "tenantId" ? `'${randomUUID()}'` : `'x'`;
      await expect(api.query(`UPDATE "ApiKey" SET "${column}" = ${value} WHERE id = $1`, [keyRow]), column).rejects.toThrow(/permission denied/);
    }
  });

  it("cf_api NO puede borrar tenants, personas ni claves, ni cambiar a quién pertenece una persona", async () => {
    await expect(api.query(`DELETE FROM "Tenant" WHERE id = $1`, [tenantRow])).rejects.toThrow(/permission denied/);
    await expect(api.query(`DELETE FROM "User" WHERE id = $1`, [userRow])).rejects.toThrow(/permission denied/);
    await expect(api.query(`DELETE FROM "ApiKey" WHERE id = $1`, [keyRow])).rejects.toThrow(/permission denied/);
    await expect(api.query(`UPDATE "User" SET "tenantId" = $2 WHERE id = $1`, [userRow, randomUUID()])).rejects.toThrow(/permission denied/);
    await expect(api.query(`UPDATE "Tenant" SET name = 'x' WHERE id = $1`, [tenantRow])).rejects.toThrow(/permission denied/);
  });

  it("claves externas (ADR 0020): cf_api crea, lee, reemplaza el cifrado y borra, pero no reescribe a quién ni a qué proveedor pertenecen", async () => {
    const row = randomUUID();
    await api.query(
      `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4, "createdBy") VALUES ($1, $2, 'openai', 'v1.x.y.z', 1, 'abcd', $3)`,
      [row, tenantRow, userRow],
    );
    expect((await api.query(`SELECT provider, last4 FROM "TenantExternalKey" WHERE id = $1`, [row])).rows).toEqual([{ provider: "openai", last4: "abcd" }]);
    await api.query(`UPDATE "TenantExternalKey" SET ciphertext = 'v1.a.b.c', "keyVersion" = 1, last4 = 'wxyz', "rotatedAt" = now() WHERE id = $1`, [row]);
    // createdBy es de auditoría: quien la guardó primero no se reescribe.
    for (const column of ["tenantId", "provider", "id", "createdBy", "createdAt"]) {
      const value = column === "provider" ? `'elevenlabs'` : column === "createdAt" ? "now()" : `'${randomUUID()}'`;
      await expect(api.query(`UPDATE "TenantExternalKey" SET "${column}" = ${value} WHERE id = $1`, [row]), column).rejects.toThrow(/permission denied/);
    }
    // Una sola clave por proveedor y espacio.
    await expect(
      api.query(`INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, 'openai', 'v1.x.y.z', 1, 'abcd')`, [randomUUID(), tenantRow]),
    ).rejects.toThrow(/duplicate key|unique/i);
    await api.query(`DELETE FROM "TenantExternalKey" WHERE id = $1`, [row]); // borrar de verdad: una clave retirada no debe quedar cifrada en la base
    expect((await api.query(`SELECT 1 FROM "TenantExternalKey" WHERE id = $1`, [row])).rowCount).toBe(0);
  });

  it("claves externas: cf_worker NO tiene ningún permiso sobre la tabla ni sobre ninguna de sus columnas", async () => {
    await expect(worker.query(`SELECT * FROM "TenantExternalKey"`)).rejects.toThrow(/permission denied/);
    await expect(worker.query(`SELECT ciphertext FROM "TenantExternalKey"`)).rejects.toThrow(/permission denied/);
    await expect(worker.query(`INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, 'openai', 'x', 1, 'abcd')`, [randomUUID(), tenantRow])).rejects.toThrow(/permission denied/);
    await expect(worker.query(`UPDATE "TenantExternalKey" SET ciphertext = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(worker.query(`DELETE FROM "TenantExternalKey"`)).rejects.toThrow(/permission denied/);
    // Ni siquiera por una consulta de catálogo: el rol no tiene el privilegio en ninguna forma.
    const privileges = await owner.query<{ priv: string; allowed: boolean }>(
      `SELECT priv, has_table_privilege('cf_worker', '"TenantExternalKey"', priv) AS allowed FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS priv`,
    );
    expect(privileges.rows.filter((row) => row.allowed)).toEqual([]);
    const columns = await owner.query<{ allowed: boolean }>(
      `SELECT has_column_privilege('cf_worker', '"TenantExternalKey"', attname, 'SELECT') AS allowed FROM pg_attribute WHERE attrelid = '"TenantExternalKey"'::regclass AND attnum > 0 AND NOT attisdropped`,
    );
    expect(columns.rows.length).toBeGreaterThan(5);
    expect(columns.rows.filter((row) => row.allowed)).toEqual([]);
  });

  it("claves externas: cf_api tampoco puede vaciar la tabla ni cambiar su estructura", async () => {
    await expect(api.query(`TRUNCATE "TenantExternalKey"`)).rejects.toThrow(/permission denied/);
    await expect(api.query(`ALTER TABLE "TenantExternalKey" DROP COLUMN ciphertext`)).rejects.toThrow(/must be owner/);
  });

  it("los tipos de trabajo TRANSLATE y DUB existen", async () => {
    for (const kind of ["TRANSLATE", "DUB"]) {
      const job = randomUUID();
      await api.query(insert.replace("'TRANSCRIBE'", `'${kind}'`), [job]);
      expect((await api.query(`SELECT kind::text AS kind FROM "Job" WHERE id = $1`, [job])).rows).toEqual([{ kind }]);
      await api.query(`DELETE FROM "Job" WHERE id = $1`, [job]);
    }
  });

  it("cf_worker no ve nada de la tenencia ni de las sesiones", async () => {
    for (const table of ["Tenant", "ApiKey", "User", "Session"]) {
      await expect(worker.query(`SELECT * FROM "${table}"`), table).rejects.toThrow(/permission denied/);
    }
  });
});
