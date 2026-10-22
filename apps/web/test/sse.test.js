import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { SseParser, followJob, isTerminalStatus, parseJobView, streamJobEvents } from "../public/js/api/sse.js";

const ID = "6f1d2c3e-1111-4222-8333-444455556666";
const view = (overrides = {}) => ({ id: ID, status: "RUNNING", stage: "transcribing", percent: 40, message: null, ...overrides });
const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** Parser con los eventos que va entregando. */
function parse(...chunks) {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe("SseParser: formato text/event-stream", () => {
  it("un evento con nombre y datos", () => {
    assert.deepEqual(parse('event: job\ndata: {"a":1}\n\n'), [{ type: "job", data: '{"a":1}' }]);
  });

  it("sin «event:» el tipo es «message»", () => {
    assert.deepEqual(parse("data: hola\n\n"), [{ type: "message", data: "hola" }]);
  });

  it("varias líneas data se unen con salto de línea", () => {
    assert.deepEqual(parse("data: uno\ndata: dos\n\n"), [{ type: "message", data: "uno\ndos" }]);
  });

  it("acepta \\r\\n, \\n y \\r como fin de línea", () => {
    assert.equal(parse("event: a\r\ndata: 1\r\n\r\n")[0].data, "1");
    // Un «\r» final podría ser la mitad de un «\r\n»: el evento sale cuando llega el byte siguiente.
    assert.equal(parse("event: a\rdata: 2\r\rdata: z")[0].data, "2");
    assert.equal(parse("event: a\ndata: 3\n\n")[0].data, "3");
  });

  it("un \\r\\n partido entre dos trozos no cuenta como dos saltos", () => {
    assert.deepEqual(parse("data: x\r", "\n\r", "\n"), [{ type: "message", data: "x" }]);
  });

  it("un evento partido en trozos de cualquier tamaño llega entero", () => {
    const text = frame("job", view()) + frame("ping", {});
    for (let size = 1; size <= 9; size++) {
      const chunks = text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"));
      assert.deepEqual(parse(...chunks).map((event) => event.type), ["job", "ping"], `trozos de ${size}`);
    }
  });

  it("los comentarios (líneas con «:») se ignoran", () => {
    assert.deepEqual(parse(": keep-alive\n\ndata: a\n\n"), [{ type: "message", data: "a" }]);
  });

  it("quita un solo espacio tras los dos puntos, no más", () => {
    assert.equal(parse("data:  dos\n\n")[0].data, " dos");
    assert.equal(parse("data:sin\n\n")[0].data, "sin");
  });

  it("un evento sin datos no se entrega", () => {
    assert.deepEqual(parse("event: job\n\n"), []);
  });

  it("el tipo no se arrastra al evento siguiente", () => {
    assert.deepEqual(parse("event: job\ndata: 1\n\ndata: 2\n\n").map((event) => event.type), ["job", "message"]);
  });

  it("un evento incompleto al cortarse el flujo no se entrega", () => {
    assert.deepEqual(parse("event: job\ndata: {"), []);
  });

  it("ignora la marca BOM del principio", () => {
    assert.deepEqual(parse("﻿data: a\n\n"), [{ type: "message", data: "a" }]);
  });

  it("campos desconocidos (id, retry) no rompen nada", () => {
    assert.deepEqual(parse("id: 7\nretry: 3000\nfoo: bar\ndata: a\n\n"), [{ type: "message", data: "a" }]);
  });
});

describe("parseJobView", () => {
  it("acepta un trabajo bien formado", () => {
    assert.equal(parseJobView(JSON.stringify(view())).percent, 40);
  });

  it("rechaza lo que no es JSON, lo que no es un objeto y los estados o porcentajes inválidos", () => {
    for (const bad of ["{", "null", "[]", JSON.stringify(view({ status: "NOPE" })), JSON.stringify(view({ percent: "40" })), JSON.stringify({ status: "RUNNING", percent: 1 })]) {
      assert.throws(() => parseJobView(bad), (error) => error instanceof ApiError && error.code === "bad_response", bad);
    }
  });

  it("acota el porcentaje a 0..100", () => {
    assert.equal(parseJobView(JSON.stringify(view({ percent: 250 }))).percent, 100);
    assert.equal(parseJobView(JSON.stringify(view({ percent: -3 }))).percent, 0);
  });

  it("COMPLETED, FAILED y CANCELLED son terminales", () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) assert.equal(isTerminalStatus(status), true);
    for (const status of ["QUEUED", "RUNNING"]) assert.equal(isTerminalStatus(status), false);
  });
});

/** Respuesta de fetch cuyo cuerpo entrega los trozos dados y luego termina (o falla con `failWith`). */
function sseResponse(chunks, { status = 200, headers = {}, failWith, hang = false } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      if (failWith) controller.error(failWith);
      else if (!hang) controller.close();
    },
  });
  return new Response(status === 200 ? body : JSON.stringify({ message: "x" }), {
    status,
    headers: status === 200 ? { "content-type": "text/event-stream", ...headers } : { "content-type": "application/json", ...headers },
  });
}

describe("streamJobEvents", () => {
  it("entrega cada evento «job» y termina cuando el trabajo llega a un estado final", async () => {
    const seen = [];
    const fetchImpl = async () =>
      sseResponse([frame("job", view({ status: "QUEUED", stage: null, percent: 0 })), frame("job", view({ percent: 60 })), frame("job", view({ status: "COMPLETED", percent: 100 })), frame("job", view({ percent: 1 }))]);
    const outcome = await streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob: (job) => seen.push(job.status) });
    assert.deepEqual(seen, ["QUEUED", "RUNNING", "COMPLETED"]); // lo que llegue tras el final se ignora
    assert.equal(outcome.reason, "terminal");
    assert.equal(outcome.job.status, "COMPLETED");
  });

  it("pide la URL del trabajo con Accept: text/event-stream y sin caché", async () => {
    let call;
    const fetchImpl = async (url, init) => ((call = { url, init }), sseResponse([frame("job", view({ status: "FAILED" }))]));
    await streamJobEvents({ baseUrl: "http://api.test/", jobId: ID, fetchImpl, onJob() {} });
    assert.equal(call.url, `http://api.test/v1/jobs/${ID}/events`);
    assert.equal(call.init.headers.Accept, "text/event-stream");
    assert.equal(call.init.cache, "no-store");
  });

  it("los ping avisan de que el flujo sigue vivo y no son trabajos", async () => {
    const jobs = [];
    let pings = 0;
    const fetchImpl = async () => sseResponse([frame("ping", {}), frame("job", view({ status: "CANCELLED" }))]);
    await streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob: (job) => jobs.push(job), onPing: () => pings++ });
    assert.equal(pings, 1);
    assert.equal(jobs.length, 1);
  });

  it("si el flujo se cierra sin estado final lo dice (el servidor corta a los 1800 s)", async () => {
    const fetchImpl = async () => sseResponse([frame("job", view())]);
    const outcome = await streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {} });
    assert.equal(outcome.reason, "ended");
  });

  it("429 y 503 llevan el Retry-After del servidor", async () => {
    for (const [status, code] of [[429, "rate_limited"], [503, "busy"]]) {
      const fetchImpl = async () => sseResponse([], { status, headers: { "retry-after": "30" } });
      await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {} }), (error) => error.code === code && error.retryAfter === 30);
    }
  });

  it("404 es not_found; un 500 es server", async () => {
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl: async () => sseResponse([], { status: 404 }), onJob() {} }), (error) => error.code === "not_found");
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl: async () => sseResponse([], { status: 500 }), onJob() {} }), (error) => error.code === "server");
  });

  it("un 200 que no es text/event-stream (portal cautivo, proxy) es bad_response", async () => {
    const fetchImpl = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {} }), (error) => error.code === "bad_response");
  });

  it("un fallo de red al conectar o a mitad del flujo es 'network'", async () => {
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, onJob() {} }), (error) => error.code === "network");
    const fetchImpl = async () => sseResponse([frame("job", view())], { failWith: new TypeError("terminated") });
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {} }), (error) => error.code === "network");
  });

  it("un evento «job» con datos inválidos es bad_response", async () => {
    const fetchImpl = async () => sseResponse(["event: job\ndata: {nada\n\n"]);
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {} }), (error) => error.code === "bad_response");
  });

  it("abortar con la señal corta el flujo y se ve como 'aborted', no como fallo", async () => {
    const controller = new AbortController();
    const fetchImpl = async (_url, init) => {
      init.signal.addEventListener("abort", () => {}, { once: true });
      return sseResponse([frame("job", view())], { hang: true });
    };
    const promise = streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, signal: controller.signal, onJob: () => controller.abort() });
    await assert.rejects(promise, (error) => error.code === "aborted");
  });

  it("sin datos durante staleMs se da el flujo por muerto y se corta", async () => {
    const fetchImpl = async (_url, init) => {
      const response = sseResponse([frame("job", view())], { hang: true });
      init.signal.addEventListener("abort", () => {}, { once: true });
      return response;
    };
    const outcome = await streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {}, staleMs: 40 });
    assert.equal(outcome.reason, "stale");
  });

  it("un trabajo con id ajeno al pedido se rechaza", async () => {
    const fetchImpl = async () => sseResponse([frame("job", view({ id: "00000000-0000-4000-8000-000000000000" }))]);
    await assert.rejects(streamJobEvents({ baseUrl: "", jobId: ID, fetchImpl, onJob() {} }), (error) => error.code === "bad_response");
  });
});

/** Sleep falso: anota las esperas y no espera. */
function fakeSleep() {
  const waits = [];
  const sleep = async (ms, signal) => {
    waits.push(ms);
    if (signal?.aborted) throw ApiError.aborted();
  };
  return { sleep, waits };
}

describe("followJob: reconexión", () => {
  it("devuelve el trabajo final del primer flujo si termina bien", async () => {
    const fetchImpl = async () => sseResponse([frame("job", view({ status: "COMPLETED", percent: 100 }))]);
    const { sleep } = fakeSleep();
    const final = await followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep, onJob() {} });
    assert.equal(final.status, "COMPLETED");
  });

  it("si el flujo se cierra sin estado final reconecta de inmediato y sigue", async () => {
    const responses = [sseResponse([frame("job", view({ percent: 10 }))]), sseResponse([frame("job", view({ status: "COMPLETED", percent: 100 }))])];
    const { sleep, waits } = fakeSleep();
    const states = [];
    const final = await followJob({ baseUrl: "", jobId: ID, fetchImpl: async () => responses.shift(), sleep, onJob: (job) => states.push(job.percent), onConnection: (state) => states.push(state.kind) });
    assert.equal(final.status, "COMPLETED");
    assert.deepEqual(waits, []); // el flujo había dado datos: no hay espera
    assert.ok(states.includes("reconnecting"));
  });

  it("un corte de red reconecta con espera creciente (1, 2, 4 s) y avisa de cada intento", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls <= 3) throw new TypeError("Failed to fetch");
      return sseResponse([frame("job", view({ status: "COMPLETED", percent: 100 }))]);
    };
    const { sleep, waits } = fakeSleep();
    const waitingFor = [];
    await followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep, onJob() {}, onConnection: (state) => state.kind === "waiting" && waitingFor.push(state.seconds) });
    assert.deepEqual(waits, [1000, 2000, 4000]);
    assert.deepEqual(waitingFor, [1, 2, 4]);
  });

  it("429/503 esperan lo que pide el servidor (Retry-After)", async () => {
    const responses = [sseResponse([], { status: 429, headers: { "retry-after": "30" } }), sseResponse([frame("job", view({ status: "COMPLETED", percent: 100 }))])];
    const { sleep, waits } = fakeSleep();
    await followJob({ baseUrl: "", jobId: ID, fetchImpl: async () => responses.shift(), sleep, onJob() {} });
    assert.deepEqual(waits, [30_000]);
  });

  it("404 y 400 son definitivos: no se reintentan", async () => {
    for (const status of [404, 400]) {
      let calls = 0;
      const fetchImpl = async () => (calls++, sseResponse([], { status }));
      await assert.rejects(followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep: fakeSleep().sleep, onJob() {} }), (error) => error.status === status);
      assert.equal(calls, 1);
    }
  });

  it("tras demasiados fallos seguidos se rinde con el último error", async () => {
    let calls = 0;
    const fetchImpl = async () => (calls++, Promise.reject(new TypeError("Failed to fetch")));
    await assert.rejects(followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep: fakeSleep().sleep, onJob() {}, maxFailures: 4 }), (error) => error.code === "network");
    assert.equal(calls, 4);
  });

  it("un flujo que da datos reinicia la cuenta de fallos", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls % 2 === 1) throw new TypeError("Failed to fetch");
      return calls < 8 ? sseResponse([frame("job", view({ percent: calls }))]) : sseResponse([frame("job", view({ status: "COMPLETED", percent: 100 }))]);
    };
    const { sleep, waits } = fakeSleep();
    const final = await followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep, onJob() {}, maxFailures: 2 });
    assert.equal(final.status, "COMPLETED");
    assert.ok(waits.every((ms) => ms === 1000)); // nunca pasa del primer escalón
  });

  it("abortar durante la espera termina sin más peticiones", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = async () => (calls++, Promise.reject(new TypeError("Failed to fetch")));
    const sleep = async () => controller.abort();
    await assert.rejects(followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep, signal: controller.signal, onJob() {} }), (error) => error.code === "aborted");
    assert.equal(calls, 1);
  });

  it("la espera máxima entre intentos está acotada", async () => {
    let calls = 0;
    const fetchImpl = async () => (++calls <= 9 ? Promise.reject(new TypeError("x")) : sseResponse([frame("job", view({ status: "FAILED" }))]));
    const { sleep, waits } = fakeSleep();
    await followJob({ baseUrl: "", jobId: ID, fetchImpl, sleep, onJob() {}, maxFailures: 20 });
    assert.equal(Math.max(...waits), 15_000);
  });
});
