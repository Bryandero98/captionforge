import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { initialState, reduce, viewOf } from "../public/js/domain/upload-state.js";

const FILE = { name: "clip.mp4", size: 10_000_000 };
const JOB = { id: "6f1d2c3e-1111-4222-8333-444455556666", status: "QUEUED" };

function run(...events) {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

describe("estado de la subida", () => {
  it("empieza en reposo", () => {
    assert.equal(initialState.phase, "idle");
  });

  it("start -> uploading al 0 %, con el archivo", () => {
    const state = run({ type: "start", file: FILE, at: 0 });
    assert.equal(state.phase, "uploading");
    assert.equal(state.fraction, 0);
    assert.equal(state.file, FILE);
  });

  it("progress actualiza bytes, fracción y porcentaje entero", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "progress", loaded: 2_500_000, total: 10_000_000, at: 1000 });
    assert.equal(state.fraction, 0.25);
    assert.equal(viewOf(state).percent, 25);
    assert.equal(state.loaded, 2_500_000);
  });

  it("calcula velocidad y tiempo restante con muestras separadas en el tiempo", () => {
    const state = run(
      { type: "start", file: FILE, at: 0 },
      { type: "progress", loaded: 1_000_000, total: 10_000_000, at: 1000 },
    );
    assert.equal(Math.round(state.bytesPerSecond), 1_000_000);
    assert.equal(Math.round(state.etaSeconds), 9);
  });

  it("una velocidad constante se mantiene constante (la media móvil no la deforma)", () => {
    let state = run({ type: "start", file: FILE, at: 0 });
    for (let second = 1; second <= 5; second++) {
      state = reduce(state, { type: "progress", loaded: second * 1_000_000, total: 10_000_000, at: second * 1000 });
    }
    assert.equal(Math.round(state.bytesPerSecond), 1_000_000);
    assert.equal(Math.round(state.etaSeconds), 5);
  });

  it("dos eventos en el mismo instante no dividen por cero", () => {
    const state = run(
      { type: "start", file: FILE, at: 500 },
      { type: "progress", loaded: 1000, total: 10_000_000, at: 500 },
    );
    assert.ok(Number.isFinite(state.bytesPerSecond));
    assert.ok(state.etaSeconds === null || Number.isFinite(state.etaSeconds));
  });

  it("el progreso nunca retrocede (un evento desordenado no hace bajar la barra)", () => {
    const state = run(
      { type: "start", file: FILE, at: 0 },
      { type: "progress", loaded: 6_000_000, total: 10_000_000, at: 1000 },
      { type: "progress", loaded: 5_000_000, total: 10_000_000, at: 1100 },
    );
    assert.equal(state.fraction, 0.6);
  });

  it("un archivo de 0 bytes con total 0 no rompe: la fracción queda en 0 (sin dividir por cero)", () => {
    const state = run({ type: "start", file: { name: "vacio.mp4", size: 0 }, at: 0 }, { type: "progress", loaded: 5, total: 0, at: 10 });
    assert.equal(state.fraction, 0);
  });

  it("si el navegador no informa del total (0), se usa el tamaño del archivo", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "progress", loaded: 5_000_000, total: 0, at: 10 });
    assert.equal(state.fraction, 0.5);
  });

  it("sent -> finalizing al 100 %: el servidor aún guarda el archivo en S3", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "sent", at: 5000 });
    assert.equal(state.phase, "finalizing");
    assert.equal(state.fraction, 1);
  });

  it("accepted -> queued con el trabajo", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "sent", at: 5000 }, { type: "accepted", job: JOB });
    assert.equal(state.phase, "queued");
    assert.equal(state.job, JOB);
  });

  it("failed con un error normal -> error con el ApiError y si se puede reintentar", () => {
    const error = ApiError.network();
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "failed", error });
    assert.equal(state.phase, "error");
    assert.equal(state.error, error);
    assert.equal(viewOf(state).canRetry, true);
  });

  it("failed con 'aborted' -> cancelled, no error", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "failed", error: ApiError.aborted() });
    assert.equal(state.phase, "cancelled");
    assert.equal(state.error, null);
  });

  it("un error no reintentable no ofrece reintento", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "failed", error: ApiError.local("unsupported_type") });
    assert.equal(viewOf(state).canRetry, false);
  });

  it("reset vuelve a reposo desde cualquier estado final", () => {
    for (const events of [
      [{ type: "start", file: FILE, at: 0 }, { type: "failed", error: ApiError.network() }],
      [{ type: "start", file: FILE, at: 0 }, { type: "failed", error: ApiError.aborted() }],
      [{ type: "start", file: FILE, at: 0 }, { type: "accepted", job: JOB }],
    ]) {
      assert.equal(reduce(run(...events), { type: "reset" }).phase, "idle");
    }
  });

  it("los eventos fuera de lugar se ignoran (progreso tras terminar, aceptar sin haber empezado)", () => {
    assert.equal(run({ type: "progress", loaded: 1, total: 2, at: 0 }).phase, "idle");
    assert.equal(run({ type: "accepted", job: JOB }).phase, "idle");
    const queued = run({ type: "start", file: FILE, at: 0 }, { type: "accepted", job: JOB });
    assert.equal(reduce(queued, { type: "progress", loaded: 1, total: 2, at: 9 }).phase, "queued");
    assert.equal(reduce(queued, { type: "failed", error: ApiError.network() }).phase, "queued");
  });

  it("no se puede empezar otra subida mientras hay una en curso", () => {
    const uploading = run({ type: "start", file: FILE, at: 0 });
    assert.equal(reduce(uploading, { type: "start", file: { name: "otro.mp4", size: 1 }, at: 1 }).file, FILE);
  });
});

describe("viewOf: lo que la interfaz necesita saber", () => {
  const phases = {
    idle: initialState,
    uploading: run({ type: "start", file: FILE, at: 0 }, { type: "progress", loaded: 4_000_000, total: 10_000_000, at: 1000 }),
    finalizing: run({ type: "start", file: FILE, at: 0 }, { type: "sent", at: 1 }),
    queued: run({ type: "start", file: FILE, at: 0 }, { type: "accepted", job: JOB }),
    error: run({ type: "start", file: FILE, at: 0 }, { type: "failed", error: ApiError.network() }),
    cancelled: run({ type: "start", file: FILE, at: 0 }, { type: "failed", error: ApiError.aborted() }),
  };

  it("subiendo: barra determinada con porcentaje, se puede cancelar", () => {
    const view = viewOf(phases.uploading);
    assert.equal(view.percent, 40);
    assert.equal(view.indeterminate, false);
    assert.equal(view.canCancel, true);
    assert.equal(view.busy, true);
  });

  it("finalizando: barra indeterminada (no hay forma de saber cuánto falta) y ya no se puede cancelar", () => {
    const view = viewOf(phases.finalizing);
    assert.equal(view.indeterminate, true);
    assert.equal(view.canCancel, false);
    assert.equal(view.busy, true);
    assert.equal(view.percent, 100);
  });

  it("en cola: ya no se cancela con la subida (eso pasa por POST /cancel del trabajo)", () => {
    const view = viewOf(phases.queued);
    assert.equal(view.canCancel, false);
    assert.equal(view.busy, false);
  });

  it("cancelada y con error se puede volver a intentar o empezar de nuevo", () => {
    assert.equal(viewOf(phases.cancelled).canRetry, true);
    assert.equal(viewOf(phases.error).canRetry, true);
  });

  it("en reposo no hay nada que cancelar ni reintentar", () => {
    const view = viewOf(phases.idle);
    assert.equal(view.canCancel, false);
    assert.equal(view.canRetry, false);
    assert.equal(view.busy, false);
  });

  it("el porcentaje se redondea hacia abajo: nunca muestra 100 % antes de terminar de enviar", () => {
    const state = run({ type: "start", file: FILE, at: 0 }, { type: "progress", loaded: 9_999_999, total: 10_000_000, at: 10 });
    assert.equal(viewOf(state).percent, 99);
  });
});
