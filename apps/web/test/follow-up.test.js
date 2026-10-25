// «Sube y olvídate» en el cliente (v1.3.0, T8): al completarse la transcripción se pide el quemado, una sola vez, sin bucles.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { createFollowUp } from "../public/js/ui/follow-up.js";

const ID = "6f1d2c3e-1111-4222-8333-000000000030";
const OTHER = "6f1d2c3e-1111-4222-8333-000000000031";
const VERTICAL = { burn: { canvas: "vertical", template: "bold-pop" } };
const CLASSIC = { burn: { canvas: "source", style: "modern" } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function setup({ start, fetchJob } = {}) {
  const log = { started: [], problems: [], pending: [], timers: [], cleared: [] };
  const followUp = createFollowUp({
    baseUrl: "http://api.test",
    start: start ?? (async (options) => (log.started.push(options), { id: `burn-${log.started.length}`, kind: "BURN", status: "QUEUED", percent: 0, parentJobId: options.jobId })),
    fetchJob: fetchJob ?? (async () => ({ id: ID, kind: "TRANSCRIBE", status: "RUNNING", percent: 10 })),
    onStarted: (job, name) => log.started_ui?.push([job.id, name]),
    onProblem: (problem) => log.problems.push(problem),
    onPendingChange: (count) => log.pending.push(count),
    setInterval: (fn, ms) => (log.timers.push({ fn, ms }), log.timers.length),
    clearInterval: (id) => log.cleared.push(id),
  });
  log.started_ui = [];
  return { followUp, log };
}

const completed = (id = ID) => ({ id, kind: "TRANSCRIBE", status: "COMPLETED", percent: 100 });

describe("encadenado del quemado", () => {
  it("al completarse la transcripción pide el quemado vertical con la plantilla elegida, una sola vez", async () => {
    const { followUp, log } = setup();
    followUp.register(ID, VERTICAL, "short.mp4");
    assert.equal(followUp.pending(), 1);
    followUp.onJob({ id: ID, kind: "TRANSCRIBE", status: "RUNNING", percent: 40 });
    await flush();
    assert.deepEqual(log.started, []);

    followUp.onJob(completed());
    followUp.onJob(completed()); // el mismo evento repetido (reconexión) no duplica
    await flush();
    assert.deepEqual(log.started, [{ baseUrl: "http://api.test", jobId: ID, canvas: "vertical", template: "bold-pop" }]);
    assert.deepEqual(log.started_ui, [["burn-1", "short.mp4"]]);
    assert.equal(followUp.pending(), 0);
  });

  it("el quemado clásico manda solo el estilo (como el formulario de siempre)", async () => {
    const { followUp, log } = setup();
    followUp.register(ID, CLASSIC, "clip.mp4");
    followUp.onJob(completed());
    await flush();
    assert.deepEqual(log.started, [{ baseUrl: "http://api.test", jobId: ID, style: "modern" }]);
  });

  it("un trabajo sin encadenado, de otro tipo o que no es el registrado no dispara nada", async () => {
    const { followUp, log } = setup();
    followUp.register(ID, VERTICAL, "a.mp4");
    followUp.onJob(completed(OTHER));
    followUp.onJob({ ...completed(), kind: "BURN" });
    followUp.onJob(null);
    followUp.onJob(undefined);
    await flush();
    assert.deepEqual(log.started, []);
    assert.equal(followUp.pending(), 1);
  });

  it("registrar sin encadenado no cuenta como pendiente", () => {
    const { followUp } = setup();
    followUp.register(ID, null, "a.mp4");
    assert.equal(followUp.pending(), 0);
  });

  it("si la transcripción falla o se cancela, se olvida el encadenado y no se crea nada", async () => {
    for (const status of ["FAILED", "CANCELLED"]) {
      const { followUp, log } = setup();
      followUp.register(ID, VERTICAL, "a.mp4");
      followUp.onJob({ ...completed(), status });
      await flush();
      assert.deepEqual(log.started, [], status);
      assert.equal(followUp.pending(), 0, status);
    }
  });
});

describe("encadenado: fallos", () => {
  it("un 409 o un 413 se avisa una vez y NO se reintenta", async () => {
    for (const code of ["conflict", "job_too_large"]) {
      let calls = 0;
      const { followUp, log } = setup({ start: async () => (calls++, Promise.reject(new ApiError({ code, status: code === "conflict" ? 409 : 413 }))) });
      followUp.register(ID, VERTICAL, "a.mp4");
      followUp.onJob(completed());
      followUp.onJob(completed());
      await flush();
      assert.equal(calls, 1, code);
      assert.equal(log.problems.length, 1, code);
      assert.equal(log.problems[0].code, code);
      assert.equal(log.problems[0].name, "a.mp4");
      assert.equal(followUp.pending(), 0);
    }
  });

  it("un error que no es del API (un bug) se avisa como fallo de red y no se propaga", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { followUp, log } = setup({ start: async () => Promise.reject(new TypeError("raro")) });
      followUp.register(ID, VERTICAL, "a.mp4");
      followUp.onJob(completed());
      await flush();
      assert.equal(log.problems[0].code, "network");
    } finally {
      console.error = quiet;
    }
  });

  it("si la interfaz falla al mostrar el quemado creado, no se pierde ni se repite", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      let calls = 0;
      const followUp = createFollowUp({
        baseUrl: "",
        start: async () => (calls++, { id: "b", kind: "BURN", status: "QUEUED", percent: 0 }),
        fetchJob: async () => completed(),
        onStarted: () => {
          throw new Error("DOM roto");
        },
        onProblem: () => {},
        onPendingChange: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
      });
      followUp.register(ID, VERTICAL, "a.mp4");
      followUp.onJob(completed());
      await flush();
      assert.equal(calls, 1);
    } finally {
      console.error = quiet;
    }
  });
});

describe("encadenado: lotes y consulta periódica", () => {
  it("avisa de los cambios de pendientes", async () => {
    const { followUp, log } = setup();
    followUp.register(ID, VERTICAL, "a.mp4");
    followUp.register(OTHER, VERTICAL, "b.mp4");
    followUp.onJob(completed());
    await flush();
    assert.deepEqual(log.pending, [1, 2, 1]);
  });

  it("los trabajos que el seguimiento principal no ve se consultan de uno en uno, por turnos", async () => {
    const asked = [];
    const { followUp, log } = setup({
      fetchJob: async ({ jobId }) => (asked.push(jobId), jobId === OTHER ? completed(OTHER) : { id: ID, kind: "TRANSCRIBE", status: "RUNNING", percent: 5 }),
    });
    followUp.register(ID, VERTICAL, "a.mp4");
    followUp.register(OTHER, CLASSIC, "b.mp4");
    assert.equal(log.timers.length, 1, "un solo temporizador para todos");
    await log.timers[0].fn();
    await log.timers[0].fn();
    await flush();
    assert.deepEqual(asked, [ID, OTHER]);
    assert.deepEqual(log.started.map((s) => s.jobId), [OTHER]);
    assert.equal(followUp.pending(), 1);
  });

  it("un trabajo que el servidor ya no tiene (404) se olvida; otros errores de consulta se ignoran y se vuelve a intentar", async () => {
    let mode = "boom";
    const { followUp, log } = setup({ fetchJob: async () => (mode === "boom" ? Promise.reject(ApiError.network()) : Promise.reject(new ApiError({ code: "not_found", status: 404 }))) });
    followUp.register(ID, VERTICAL, "a.mp4");
    await log.timers[0].fn();
    assert.equal(followUp.pending(), 1);
    mode = "gone";
    await log.timers[0].fn();
    assert.equal(followUp.pending(), 0);
  });

  it("el temporizador se detiene cuando no queda nada pendiente y no corre dos consultas a la vez", async () => {
    let release;
    const { followUp, log } = setup({ fetchJob: () => new Promise((resolve) => (release = resolve)) });
    followUp.register(ID, VERTICAL, "a.mp4");
    const first = log.timers[0].fn();
    await log.timers[0].fn(); // superpuesta: no hace nada
    release(completed());
    await first;
    await flush();
    assert.deepEqual(log.cleared, [1]);
    assert.equal(log.started.length, 1);
  });

  it("stop() olvida todo y detiene el temporizador", () => {
    const { followUp, log } = setup();
    followUp.register(ID, VERTICAL, "a.mp4");
    followUp.stop();
    assert.equal(followUp.pending(), 0);
    assert.deepEqual(log.cleared, [1]);
  });
});
