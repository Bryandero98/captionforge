// La migración de membresías (ADR 0019) sobre una base CON personas ya registradas. Se prueba en un esquema temporal dentro de
// una transacción que siempre se deshace: no toca los datos reales. Rol dueño (cf_owner), que puede crear esquemas.
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

interface Legacy {
  solo: { userId: string; tenantId: string };
  teamTenant: string;
  teamUsers: string[];
  defaultUser: string;
}

/** Corre `body` en un esquema vacío con las migraciones ANTERIORES aplicadas y personas "antiguas"; siempre deshace. */
async function onLegacyDatabase<T>(body: (legacy: Legacy) => Promise<T>): Promise<T> {
  const schema = `tmp_members_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await owner.query("BEGIN");
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    await owner.query(`SET LOCAL search_path TO ${schema}`);
    // La migración inicial toca "_prisma_migrations" por nombre sin esquema; en el esquema temporal hace falta una de mentira.
    await owner.query(`CREATE TABLE "_prisma_migrations" (id int)`);
    for (const name of ["init", "tenancy", "sessions"]) await owner.query(migration(name));

    const person = async (tenantId: string, label: string): Promise<string> => {
      const id = randomUUID();
      await owner.query(`INSERT INTO "User" (id, "tenantId", email, name, provider, subject) VALUES ($1, $2, $3, $4, 'github', $5)`, [id, tenantId, `${label}@example.com`, label, `${label}-${id}`]);
      return id;
    };
    const tenant = async (name: string): Promise<string> => {
      const id = randomUUID();
      await owner.query(`INSERT INTO "Tenant" (id, name) VALUES ($1, $2)`, [id, name]);
      return id;
    };

    const soloTenant = await tenant("ana");
    const teamTenant = await tenant("equipo");
    const legacy: Legacy = {
      solo: { userId: await person(soloTenant, "ana"), tenantId: soloTenant },
      teamTenant,
      // Un tenant con dos personas: el modelo anterior ya lo permitía (Tenant 1:N User) y ambas tenían acceso completo.
      teamUsers: [await person(teamTenant, "beto"), await person(teamTenant, "carla")],
      defaultUser: await person(DEFAULT_TENANT_ID, "local"),
    };
    return await body(legacy);
  } finally {
    await owner.query("ROLLBACK");
  }
}

const memberships = async () =>
  (await owner.query<{ userId: string; tenantId: string; role: string }>(`SELECT "userId", "tenantId", role::text AS role FROM "Membership" ORDER BY "userId"`)).rows;

describe("migración de membresías", () => {
  it("rojo: antes de la migración no existe ninguna membresía", async () => {
    await onLegacyDatabase(async () => {
      await owner.query("SAVEPOINT intento");
      await expect(owner.query(`SELECT 1 FROM "Membership"`)).rejects.toMatchObject({ code: "42P01" });
      await owner.query("ROLLBACK TO SAVEPOINT intento");
    });
  });

  it("verde: cada persona existente pasa a ser Dueño de su tenant, y User.tenantId queda intacto", async () => {
    await onLegacyDatabase(async (legacy) => {
      await owner.query(migration("memberships"));

      const everyone = [legacy.solo.userId, ...legacy.teamUsers, legacy.defaultUser];
      const rows = await memberships();
      expect(rows.map((row) => row.userId).sort()).toEqual([...everyone].sort());
      expect(rows.every((row) => row.role === "OWNER")).toBe(true);

      const tenantOf = new Map(rows.map((row) => [row.userId, row.tenantId]));
      expect(tenantOf.get(legacy.solo.userId)).toBe(legacy.solo.tenantId);
      for (const id of legacy.teamUsers) expect(tenantOf.get(id)).toBe(legacy.teamTenant);
      expect(tenantOf.get(legacy.defaultUser)).toBe(DEFAULT_TENANT_ID);

      // Expandir y contraer: la columna anterior no se toca en esta entrega.
      const users = await owner.query<{ id: string; tenantId: string }>(`SELECT id, "tenantId" FROM "User"`);
      for (const user of users.rows) expect(user.tenantId).toBe(tenantOf.get(user.id));
    });
  });

  it("una base sin personas se migra sin membresías (y sin fallar)", async () => {
    const schema = `tmp_members_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await owner.query("BEGIN");
    try {
      await owner.query(`CREATE SCHEMA ${schema}`);
      await owner.query(`SET LOCAL search_path TO ${schema}`);
      await owner.query(`CREATE TABLE "_prisma_migrations" (id int)`);
      for (const name of ["init", "tenancy", "sessions", "memberships"]) await owner.query(migration(name));
      expect(await memberships()).toEqual([]);
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("restricciones: rol válido, una membresía por persona y espacio, y claves foráneas", async () => {
    await onLegacyDatabase(async (legacy) => {
      await owner.query(migration("memberships"));
      const attempt = async (sql: string, params: unknown[], code: string) => {
        await owner.query("SAVEPOINT intento");
        await expect(owner.query(sql, params)).rejects.toMatchObject({ code });
        await owner.query("ROLLBACK TO SAVEPOINT intento");
      };
      const insert = `INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, $3)`;
      await attempt(insert, [legacy.solo.userId, legacy.teamTenant, "ADMIN"], "22P02"); // rol que no existe
      await attempt(insert, [legacy.solo.userId, legacy.solo.tenantId, "VIEWER"], "23505"); // ya es miembro
      await attempt(insert, [randomUUID(), legacy.teamTenant, "VIEWER"], "23503"); // persona inexistente
      await attempt(insert, [legacy.solo.userId, randomUUID(), "VIEWER"], "23503"); // espacio inexistente

      // Una persona puede ser miembro de más de un espacio, con roles distintos.
      await owner.query(insert, [legacy.solo.userId, legacy.teamTenant, "VIEWER"]);
      const roles = (await memberships()).filter((row) => row.userId === legacy.solo.userId).map((row) => row.role).sort();
      expect(roles).toEqual(["OWNER", "VIEWER"]);
    });
  });

  it("no se puede borrar un espacio con miembros (RESTRICT), y borrar a la persona borra sus membresías (CASCADE)", async () => {
    await onLegacyDatabase(async (legacy) => {
      await owner.query(migration("memberships"));
      await owner.query("SAVEPOINT intento");
      await expect(owner.query(`DELETE FROM "Tenant" WHERE id = $1`, [legacy.teamTenant])).rejects.toMatchObject({ code: "23503" });
      await owner.query("ROLLBACK TO SAVEPOINT intento");

      await owner.query(`DELETE FROM "User" WHERE id = $1`, [legacy.solo.userId]);
      expect((await memberships()).some((row) => row.userId === legacy.solo.userId)).toBe(false);
    });
  });

  it("la sesión puede recordar el espacio activo (columna opcional)", async () => {
    await onLegacyDatabase(async (legacy) => {
      await owner.query(migration("memberships"));
      const column = await owner.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Session' AND column_name = 'tenantId'`,
      );
      expect(column.rows[0]?.is_nullable).toBe("YES");
      await owner.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt", "tenantId") VALUES ($1, $2, 'h', now() + interval '1 day', $3)`, [randomUUID(), legacy.solo.userId, legacy.solo.tenantId]);
    });
  });
});
