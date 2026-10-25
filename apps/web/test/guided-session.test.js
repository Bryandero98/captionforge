// Sesión de medición del editor guiado (ADR 0027): debounce, cancelación, descarte de respuestas viejas y avisos ignorados.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGuidedSession } from "../public/js/domain/guided-session.js";

const report = (n, issues = []) => ({ profile: "netflix", summary: { segments: 1, errors: 0, warnings: issues.length, infos: 0, score: n }, issues, fixes: [] });
const issue = (segment, rule) => ({ segment, rule, severity: "warning", measured: 1, limit: 1 });

function harness({ delayMs = 600 } = {}) {
  const timers = [];
  const calls = [];
  const updates = [];
  const session = createGuidedSession({
    delayMs,
    check: (segments, signal) =>
      new Promise((resolve, reject) => {
        const call = { segments, signal, resolve, reject };
        signal.addEventListener("abort", () => reject(new DOMException("cancelado", "AbortError")));
        calls.push(call);
      }),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, live: true });
      return timers.length - 1;
    },
    clearTimer: (id) => {
      if (timers[id]) timers[id].live = false;
    },
    onUpdate: (snapshot) => updates.push(snapshot),
  });
  const fire = () => timers.filter((timer) => timer.live).forEach((timer) => ((timer.live = false), timer.fn()));
  return { session, timers, calls, updates, fire };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const seg = (text) => [{ start: 0, end: 2, text }];

describe("debounce", () => {
  it("espera el tiempo configurado y manda solo la última versión", async () => {
    const { session, timers, calls, fire } = harness();
    session.schedule(seg("a"));
    session.schedule(seg("ab"));
    session.schedule(seg("abc"));
    assert.equal(calls.length, 0);
    assert.equal(timers.filter((t) => t.live).length, 1);
    assert.equal(timers[0].ms, 600);
    fire();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].segments[0].text, "abc");
    assert.equal(session.snapshot().status, "pending");
  });

  it("run mide de inmediato sin esperar", () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    assert.equal(calls.length, 1);
  });
});

describe("respuestas", () => {
  it("una respuesta vigente deja el informe listo y fresco", async () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    calls[0].resolve(report(80, [issue(0, "cps")]));
    await flush();
    const snap = session.snapshot();
    assert.equal(snap.status, "ready");
    assert.equal(snap.fresh, true);
    assert.equal(snap.report.summary.score, 80);
  });

  it("una petición nueva cancela la anterior y descarta su respuesta aunque llegue tarde", async () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    session.run(seg("ab"));
    assert.equal(calls[0].signal.aborted, true);
    calls[0].resolve(report(10));
    calls[1].resolve(report(90));
    await flush();
    assert.equal(session.snapshot().report.summary.score, 90);
  });

  it("al programar una medición nueva el informe queda como viejo hasta que llegue (no se aplican arreglos viejos)", async () => {
    const { session, calls, fire } = harness();
    session.run(seg("a"));
    calls[0].resolve(report(80));
    await flush();
    session.schedule(seg("ab"));
    assert.equal(session.snapshot().fresh, false);
    assert.equal(session.snapshot().report.summary.score, 80); // se sigue mostrando
    fire();
    calls[1].resolve(report(95));
    await flush();
    assert.equal(session.snapshot().fresh, true);
  });

  it("un error de red deja el estado «error» conservando el último informe; reintenta con la siguiente edición", async () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    calls[0].resolve(report(80));
    await flush();
    session.run(seg("ab"));
    calls[1].reject(new Error("red"));
    await flush();
    assert.equal(session.snapshot().status, "error");
    assert.equal(session.snapshot().report.summary.score, 80);
    session.run(seg("abc"));
    assert.equal(session.snapshot().status, "pending");
  });

  it("una cancelación no cuenta como error", async () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    session.stop();
    await flush();
    assert.notEqual(session.snapshot().status, "error");
    assert.equal(calls[0].signal.aborted, true);
  });
});

describe("pausa por validaciones locales", () => {
  it("pause cancela lo pendiente y no manda nada hasta la siguiente medición", async () => {
    const { session, calls, fire } = harness();
    session.schedule(seg("a"));
    session.pause();
    fire();
    assert.equal(calls.length, 0);
    assert.equal(session.snapshot().status, "paused");
    assert.equal(session.snapshot().fresh, false);
  });
});

describe("avisos ignorados (solo esta sesión)", () => {
  it("ignore oculta una regla de un subtítulo y visibleIssues la filtra; unignoreAll los devuelve", async () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    calls[0].resolve(report(80, [issue(0, "cps"), issue(0, "cpl"), issue(1, "cps")]));
    await flush();
    session.ignore(0, "cps");
    assert.deepEqual(session.visibleIssues().map((i) => `${i.segment}:${i.rule}`), ["0:cpl", "1:cps"]);
    assert.equal(session.ignoredCount(), 1);
    session.unignoreAll();
    assert.equal(session.visibleIssues().length, 3);
  });

  it("reset olvida informe e ignorados al cambiar de transcripción", async () => {
    const { session, calls } = harness();
    session.run(seg("a"));
    calls[0].resolve(report(80, [issue(0, "cps")]));
    await flush();
    session.ignore(0, "cps");
    session.reset();
    assert.equal(session.snapshot().status, "idle");
    assert.equal(session.snapshot().report, null);
    assert.equal(session.ignoredCount(), 0);
  });
});

describe("avisos de cambio", () => {
  it("avisa a onUpdate en cada cambio de estado", async () => {
    const { session, calls, updates } = harness();
    session.run(seg("a"));
    calls[0].resolve(report(80));
    await flush();
    assert.deepEqual(updates.map((u) => u.status), ["pending", "ready"]);
  });
});
