import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { initialTracking, trackingReduce, trackingViewOf } from "../public/js/domain/job-state.js";

const ID = "6f1d2c3e-1111-4222-8333-444455556666";
const job = (overrides = {}) => ({ id: ID, status: "RUNNING", stage: "transcribing", percent: 40, message: null, ...overrides });
const run = (...events) => events.reduce(trackingReduce, initialTracking);

describe("seguimiento de un trabajo", () => {
  it("sin seguimiento no hay nada que mostrar", () => {
    assert.equal(trackingViewOf(initialTracking).kind, "none");
  });

  it("al empezar a seguir: en cola, barra indeterminada", () => {
    const view = trackingViewOf(run({ type: "track", jobId: ID }));
    assert.equal(view.kind, "queued");
    assert.equal(view.indeterminate, true);
  });

  it("QUEUED: en cola y sin porcentaje", () => {
    const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: job({ status: "QUEUED", stage: null, percent: 0 }) }));
    assert.equal(view.kind, "queued");
    assert.equal(view.indeterminate, true);
  });

  it("RUNNING con etapa: porcentaje redondeado hacia abajo y la etapa del contrato", () => {
    const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: job({ percent: 42.9 }) }));
    assert.equal(view.kind, "running");
    assert.equal(view.stage, "transcribing");
    assert.equal(view.percent, 42);
    assert.equal(view.indeterminate, false);
  });

  it("RUNNING sin etapa todavía: indeterminado (preparando)", () => {
    const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: job({ stage: null, percent: 0 }) }));
    assert.equal(view.kind, "running");
    assert.equal(view.indeterminate, true);
  });

  it("nunca muestra 100 % antes de COMPLETED", () => {
    const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: job({ percent: 99.96 }) }));
    assert.equal(view.percent, 99);
  });

  it("los tres estados finales son terminales; COMPLETED marca 100 %", () => {
    for (const [status, kind] of [["COMPLETED", "completed"], ["FAILED", "failed"], ["CANCELLED", "cancelled"]]) {
      const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: job({ status, percent: 100 }) }));
      assert.equal(view.kind, kind);
      assert.equal(view.terminal, true);
    }
    assert.equal(trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: job({ status: "COMPLETED", percent: 100 }) })).percent, 100);
  });

  it("FAILED lleva el código y el mensaje del trabajo", () => {
    const failed = job({ status: "FAILED", error: { code: "FFMPEG_FAILED", message: "boom" } });
    const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "job", job: failed }));
    assert.deepEqual(view.failure, { code: "FFMPEG_FAILED", message: "boom" });
  });

  it("un trabajo de otro id se ignora (llegada tardía tras empezar de nuevo)", () => {
    const state = run({ type: "track", jobId: ID }, { type: "job", job: job({ id: "00000000-0000-4000-8000-000000000000", percent: 90 }) });
    assert.equal(trackingViewOf(state).kind, "queued");
  });

  it("tras un estado final no se acepta ningún retroceso", () => {
    const state = run({ type: "track", jobId: ID }, { type: "job", job: job({ status: "COMPLETED", percent: 100 }) }, { type: "job", job: job({ percent: 10 }) });
    assert.equal(trackingViewOf(state).kind, "completed");
  });

  it("la conexión: reconectando y esperando se ven, y 'live' lo limpia", () => {
    const base = run({ type: "track", jobId: ID }, { type: "job", job: job() });
    const waiting = trackingViewOf(trackingReduce(base, { type: "connection", state: { kind: "waiting", seconds: 4 } }));
    assert.equal(waiting.connection, "waiting");
    assert.equal(waiting.waitSeconds, 4);
    assert.equal(trackingViewOf(trackingReduce(base, { type: "connection", state: { kind: "reconnecting" } })).connection, "reconnecting");
    const live = trackingViewOf(trackingReduce(trackingReduce(base, { type: "connection", state: { kind: "reconnecting" } }), { type: "connection", state: { kind: "live" } }));
    assert.equal(live.connection, "live");
  });

  it("dejar de conectar: se pierde el hilo, pero el trabajo sigue en el servidor", () => {
    const state = run({ type: "track", jobId: ID }, { type: "job", job: job() }, { type: "lost", error: ApiError.network() });
    const view = trackingViewOf(state);
    assert.equal(view.kind, "lost");
    assert.equal(view.error.code, "network");
    assert.equal(view.percent, 40); // lo último que se vio
  });

  it("un trabajo que no existe (404) es 'lost' con ese error", () => {
    const view = trackingViewOf(run({ type: "track", jobId: ID }, { type: "lost", error: new ApiError({ status: 404, code: "not_found" }) }));
    assert.equal(view.error.code, "not_found");
  });

  it("'lost' tras un estado final se ignora", () => {
    const state = run({ type: "track", jobId: ID }, { type: "job", job: job({ status: "COMPLETED", percent: 100 }) }, { type: "lost", error: ApiError.network() });
    assert.equal(trackingViewOf(state).kind, "completed");
  });

  it("reset vuelve al principio", () => {
    assert.equal(trackingViewOf(run({ type: "track", jobId: ID }, { type: "reset" })).kind, "none");
  });
});
