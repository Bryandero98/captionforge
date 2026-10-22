import { describe, expect, it } from "vitest";

import { KeyedMutex } from "../src/jobs/keyed-mutex.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("KeyedMutex", () => {
  it("las tareas con la misma clave corren de una en una y en orden de llegada", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`${name}:inicio`);
      await wait(ms);
      log.push(`${name}:fin`);
      return name;
    };
    const results = await Promise.all([mutex.run("a", task("1", 30)), mutex.run("a", task("2", 5)), mutex.run("a", task("3", 1))]);
    expect(results).toEqual(["1", "2", "3"]);
    expect(log).toEqual(["1:inicio", "1:fin", "2:inicio", "2:fin", "3:inicio", "3:fin"]);
  });

  it("claves distintas no se esperan", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      mutex.run("a", async () => (await wait(30), log.push("a"))),
      mutex.run("b", async () => (await wait(1), log.push("b"))),
    ]);
    expect(log).toEqual(["b", "a"]);
  });

  it("un fallo no bloquea a las siguientes y se propaga a quien lo provocó", async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run("a", async () => {
      throw new Error("boom");
    });
    const next = mutex.run("a", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("no acumula claves: al quedar libre se olvida", async () => {
    const mutex = new KeyedMutex();
    await mutex.run("a", async () => 1);
    expect((mutex as unknown as { tails: Map<string, unknown> }).tails.size).toBe(0);
  });
});
