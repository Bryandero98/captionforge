// Listado de trabajos acotado (protección contra consultas sin tope): por defecto 20, nunca más de 100, y el tope se aplica
// también dentro del servicio, no solo en el controlador.
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { JobsController } from "../src/jobs/jobs.controller.js";
import { JobsService, MAX_LIST_LIMIT } from "../src/jobs/jobs.service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CURSOR = "6f1d2c3e-1111-4222-8333-000000000001";

function controller() {
  const list = vi.fn(async () => ({ jobs: [], nextCursor: null }));
  const instance = new JobsController({ list } as unknown as JobsService, {} as never, {} as never);
  return { instance, list };
}

function service(rows: { id: string }[] = []) {
  const findMany = vi.fn(async () => rows);
  const prisma = { job: { findMany, findFirst: vi.fn(async () => ({ id: CURSOR })) } };
  const instance = new JobsService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  return { instance, findMany };
}

describe("GET /v1/jobs: controlador", () => {
  it("sin ?limit pide 20", async () => {
    const { instance, list } = controller();
    await instance.list(TENANT);
    expect(list).toHaveBeenCalledWith(TENANT, { limit: 20, cursor: undefined });
  });

  it("acepta de 1 a 100", async () => {
    const { instance, list } = controller();
    await instance.list(TENANT, "1");
    await instance.list(TENANT, "100");
    expect(list.mock.calls.map((call) => (call as unknown as [string, { limit: number }])[1].limit)).toEqual([1, 100]);
  });

  it.each(["0", "-1", "101", "1000000", "abc", "1.5", "", " ", "1e3", "NaN", "Infinity"])("rechaza ?limit=%j con 400", async (value) => {
    const { instance, list } = controller();
    expect(() => instance.list(TENANT, value)).toThrow(BadRequestException);
    expect(list).not.toHaveBeenCalled();
  });

  it("rechaza un cursor que no es un id", async () => {
    const { instance } = controller();
    expect(() => instance.list(TENANT, undefined, "no-es-uuid")).toThrow(BadRequestException);
  });

  it("pasa un cursor válido", async () => {
    const { instance, list } = controller();
    await instance.list(TENANT, "5", CURSOR);
    expect(list).toHaveBeenCalledWith(TENANT, { limit: 5, cursor: CURSOR });
  });
});

describe("JobsService.list: el tope se aplica aquí también", () => {
  it("el tope es 100", () => {
    expect(MAX_LIST_LIMIT).toBe(100);
  });

  it("consulta como mucho 101 filas (100 + 1 para saber si hay más) aunque le pidan 5000", async () => {
    const { instance, findMany } = service();
    await instance.list(TENANT, { limit: 5000 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101, where: { tenantId: TENANT } }));
  });

  it("un límite inválido (0, negativo o decimal) no llega a la base como take raro", async () => {
    for (const limit of [0, -5, 2.7, Number.NaN]) {
      const { instance, findMany } = service();
      await instance.list(TENANT, { limit });
      const take = (findMany.mock.calls[0] as unknown as [{ take: number }])[0].take;
      expect(Number.isInteger(take) && take >= 2 && take <= 101, `limit ${limit} -> take ${take}`).toBe(true);
    }
  });

  it("devuelve como mucho `limit` trabajos y el cursor del último cuando hay más", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `6f1d2c3e-1111-4222-8333-00000000000${i}`, kind: "TRANSCRIBE", parentJobId: null, status: "COMPLETED", stage: null, percent: 100, message: null, originalFilename: "a.mp4", sizeBytes: 10n, options: {}, errorCode: null, errorMessage: null, result: null, createdAt: new Date(0), startedAt: null, finishedAt: null }));
    const { instance } = service(rows as never);
    const page = await instance.list(TENANT, { limit: 3 });
    expect(page.jobs).toHaveLength(3);
    expect(page.nextCursor).toBe(rows[2]!.id);
  });
});
