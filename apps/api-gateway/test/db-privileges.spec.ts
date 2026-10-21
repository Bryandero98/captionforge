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

const insert = `INSERT INTO "Job" (id, kind, "inputBucket", "inputKey", "originalFilename", "contentType",
  "sizeBytes", "outputPrefix", options, "updatedAt")
  VALUES ($1, 'TRANSCRIBE', 'b', 'k', 'f.mp4', 'video/mp4', 1, 'jobs/x/out/', '{}', now())`;

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
