import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConcurrencyLimiter } from "../src/security/concurrency-limiter.js";

const acquire = (limiter: ConcurrencyLimiter, key?: string, ttl?: number) => limiter.tryAcquire(key, ttl);

describe("ConcurrencyLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("respeta el total y devuelve el hueco al liberar", () => {
    const limiter = new ConcurrencyLimiter({ total: 2, perKey: 0 });
    const a = acquire(limiter);
    acquire(limiter);
    expect(acquire(limiter)).toEqual({ denied: "total" });
    if ("release" in a) a.release();
    expect("release" in acquire(limiter)).toBe(true);
  });

  it("respeta el tope por clave sin afectar a otras claves", () => {
    const limiter = new ConcurrencyLimiter({ total: 0, perKey: 1 });
    acquire(limiter, "1.1.1.1");
    expect(acquire(limiter, "1.1.1.1")).toEqual({ denied: "key" });
    expect("release" in acquire(limiter, "2.2.2.2")).toBe(true);
  });

  it("liberar dos veces no devuelve dos huecos (release idempotente)", () => {
    const limiter = new ConcurrencyLimiter({ total: 1, perKey: 0 });
    const slot = acquire(limiter);
    if ("release" in slot) {
      slot.release();
      slot.release();
    }
    acquire(limiter);
    expect(limiter.active).toBe(1);
    expect(acquire(limiter)).toEqual({ denied: "total" });
  });

  it("el hueco con ttl se libera solo, por si el release nunca llega", () => {
    const limiter = new ConcurrencyLimiter({ total: 1, perKey: 0 });
    acquire(limiter, "k", 1000);
    expect(acquire(limiter, "k")).toEqual({ denied: "total" });
    vi.advanceTimersByTime(1001);
    expect(limiter.active).toBe(0);
    expect("release" in acquire(limiter, "k")).toBe(true);
  });

  it("0 significa sin límite", () => {
    const limiter = new ConcurrencyLimiter({ total: 0, perKey: 0 });
    for (let i = 0; i < 500; i++) expect("release" in acquire(limiter, "k")).toBe(true);
  });
});
