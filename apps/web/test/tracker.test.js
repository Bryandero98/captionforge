import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { trackingViewOf } from "../public/js/domain/job-state.js";
import { createTracker } from "../public/js/ui/tracker.js";

const A = "6f1d2c3e-1111-4222-8333-444455556666";
const B = "7a1d2c3e-1111-4222-8333-444455556666";
const job = (id, overrides = {}) => ({ id, status: "RUNNING", stage: "transcribing", percent: 40, message: null, kind: "TRANSCRIBE", ...overrides });

/** Follower falso: la prueba decide qué pasa y cuándo termina. */
function fakeFollower() {
  const calls = [];
  const follower = (options) =>
    new Promise((resolve, reject) => {
      calls.push({ ...options, resolve, reject });
      options.signal.addEventListener("abort", () => reject(ApiError.aborted()), { once: true });
    });
  return { follower, calls };
}

const make = (overrides = {}) => {
  const changes = [];
  const { follower, calls } = fakeFollower();
  const tracker = createTracker({ baseUrl: "", follower, onChange: () => changes.push(1), ...overrides });
  return { tracker, calls, changes };
};
const view = (tracker) => trackingViewOf(tracker.state);
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createTracker: follow", () => {
  it("empieza en cola, refleja los eventos y avisa de cada cambio", async () => {
    const { tracker, calls, changes } = make();
    void tracker.follow(A);
    assert.equal(view(tracker).kind, "queued");
    calls[0].onJob(job(A, { percent: 55 }));
    assert.equal(view(tracker).percent, 55);
    assert.ok(changes.length >= 2);
  });

  it("seguir el mismo trabajo otra vez conserva lo último visto", async () => {
    const { tracker, calls } = make();
    void tracker.follow(A);
    calls[0].onJob(job(A, { percent: 60 }));
    void tracker.follow(A);
    assert.equal(view(tracker).percent, 60);
  });

  it("seguir otro trabajo empieza de cero y los avisos del anterior se ignoran", async () => {
    const { tracker, calls } = make();
    void tracker.follow(A);
    void tracker.follow(B);
    calls[0].onJob(job(A, { percent: 90 })); // llegada tardía del seguimiento reemplazado
    calls[0].onConnection({ kind: "waiting", seconds: 9 });
    assert.equal(view(tracker).kind, "queued");
    assert.equal(view(tracker).connection, "connecting");
  });

  it("un error del follower deja el trabajo como 'perdido'; un aborto a propósito no", async () => {
    const { tracker, calls } = make();
    const first = tracker.follow(A);
    calls[0].reject(new ApiError({ code: "network" }));
    await first;
    assert.equal(view(tracker).kind, "lost");

    const second = tracker.follow(B);
    tracker.stop();
    await second;
    assert.equal(view(tracker).kind, "none");
  });

  it("un error que no es de la API (un bug) no se traga: va a la consola y se ve como perdido", async () => {
    const { tracker, calls } = make();
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      const run = tracker.follow(A);
      calls[0].reject(new TypeError("bug"));
      await run;
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.equal(view(tracker).kind, "lost");
  });

  it("si pintar falla al marcarlo perdido, no es un rechazo sin manejar", async () => {
    let fail = false;
    const { follower, calls } = fakeFollower();
    const tracker = createTracker({
      baseUrl: "",
      follower,
      onChange: () => {
        if (fail) throw new Error("render");
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const run = tracker.follow(A);
      fail = true;
      calls[0].reject(new ApiError({ code: "network" }));
      await run; // no lanza
    } finally {
      console.error = original;
    }
  });
});

describe("createTracker: open", () => {
  it("un trabajo en curso se retoma (se sigue por SSE)", async () => {
    const { tracker, calls } = make();
    const result = await tracker.open(A, async () => job(A));
    assert.equal(result.job.id, A);
    assert.equal(calls.length, 1);
    assert.equal(view(tracker).kind, "running");
  });

  it("un trabajo terminado muestra su estado final y no abre ningún flujo", async () => {
    const { tracker, calls } = make();
    await tracker.open(A, async () => job(A, { status: "COMPLETED", percent: 100 }));
    assert.equal(calls.length, 0);
    assert.equal(view(tracker).kind, "completed");
  });

  it("un 404 queda como 'perdido' con ese error y sin reintentos", async () => {
    const { tracker, calls } = make();
    const result = await tracker.open(A, async () => {
      throw new ApiError({ status: 404, code: "not_found" });
    });
    assert.equal(result.job, null);
    assert.equal(calls.length, 0);
    assert.equal(view(tracker).error.code, "not_found");
  });

  it("dos aperturas seguidas: la primera, reemplazada, no pisa a la segunda", async () => {
    const { tracker } = make();
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    const first = tracker.open(A, () => slow);
    const second = await tracker.open(B, async () => job(B, { status: "COMPLETED", percent: 100 }));
    release(job(A));
    const late = await first;
    assert.equal(late.replaced, true);
    assert.equal(second.replaced, false);
    assert.equal(tracker.state.jobId, B);
    assert.equal(view(tracker).kind, "completed");
    await tick();
  });
});
