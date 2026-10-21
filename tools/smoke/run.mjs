// Smoke test de extremo a extremo del contrato: productor Node (BullMQ) -> Redis -> worker Python.
//
// Requiere la infraestructura arriba (`npm run infra:up`) y el entorno Python del smoke:
//   py -3.13 -m venv tools/smoke/.venv && tools/smoke/.venv/Scripts/python -m pip install -r tools/smoke/requirements.txt
// Uso:  npm run smoke --workspace @captionforge/smoke
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const SCHEMAS_DIR = join(REPO, "packages", "contracts", "schemas");
const PY_CONTRACTS = join(REPO, "packages", "contracts", "generated", "python");

// --- Configuración -------------------------------------------------------------------------
function readDotEnv() {
  const file = join(REPO, ".env");
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const valor = l.slice(l.indexOf("=") + 1).replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
        return [l.slice(0, l.indexOf("=")).trim(), valor];
      }),
  );
}
const env = { ...readDotEnv(), ...process.env };
if (!env.REDIS_PASSWORD) throw new Error("Falta REDIS_PASSWORD (en .env o en el entorno).");
const connection = {
  host: env.REDIS_HOST ?? "127.0.0.1",
  port: Number(env.REDIS_PORT ?? 6379),
  password: env.REDIS_PASSWORD,
};
const LOCK_DURATION_MS = 3000;
// Cola y canal únicos por ejecución: no compite con un worker de desarrollo ni borra trabajos reales.
const RUN_ID = randomUUID().slice(0, 8);
const QUEUE_NAME = `captionforge.smoke-${RUN_ID}`;
const CANCEL_CHANNEL = `captionforge:smoke-cancel-${RUN_ID}`;
const BUCKET = env.S3_BUCKET ?? "captionforge";

// --- Validación con los MISMOS esquemas que usa Python (Ajv en modo estricto) ----------------
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const f of readdirSync(SCHEMAS_DIR).filter((x) => x.endsWith(".json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, f), "utf8")));
}
function validar(schema, data) {
  const validate = ajv.getSchema(`https://captionforge.dev/schemas/${schema}.json`);
  assert.ok(validate, `esquema desconocido: ${schema}`);
  assert.ok(validate(data), `${schema} inválido: ${ajv.errorsText(validate.errors)}`);
}

function transcribeJob(originalFilename) {
  const jobId = randomUUID();
  return {
    schemaVersion: 1,
    jobId,
    requestedAt: new Date().toISOString(),
    input: {
      bucket: BUCKET,
      objectKey: `jobs/${jobId}/input.mp4`,
      originalFilename,
      contentType: "video/mp4",
      sizeBytes: 1024,
    },
    outputPrefix: `jobs/${jobId}/out/`,
    options: { modelSize: "small", sourceLanguage: null, translateTo: null },
  };
}

// --- Arranque del worker Python --------------------------------------------------------------
function pythonDelSmoke() {
  const candidates = [
    join(HERE, ".venv", "Scripts", "python.exe"),
    join(HERE, ".venv", "bin", "python"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No existe tools/smoke/.venv (ver instrucciones al inicio de run.mjs).");
  return found;
}

const worker = spawn(pythonDelSmoke(), [join(HERE, "smoke_worker.py")], {
  env: {
    ...process.env,
    REDIS_HOST: connection.host,
    REDIS_PORT: String(connection.port),
    REDIS_PASSWORD: connection.password,
    SMOKE_LOCK_DURATION_MS: String(LOCK_DURATION_MS),
    SMOKE_QUEUE: QUEUE_NAME,
    SMOKE_CANCEL_CHANNEL: CANCEL_CHANNEL,
    PYTHONPATH: PY_CONTRACTS,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const workerLog = [];
createInterface({ input: worker.stdout }).on("line", (l) => workerLog.push(l));
createInterface({ input: worker.stderr }).on("line", (l) => workerLog.push(`[stderr] ${l}`));
const workerExit = new Promise((res) => worker.on("exit", (code) => res(code)));
worker.on("error", (e) => workerLog.push(`[spawn] ${e.message}`));
// Nunca dejar el proceso Python huérfano, falle lo que falle.
process.on("exit", () => worker.kill());
for (const senal of ["SIGINT", "SIGTERM"]) process.on(senal, () => process.exit(130));

async function esperarLinea(texto, ms = 20000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (workerLog.some((l) => l.includes(texto))) return;
    if (worker.exitCode !== null) throw new Error(`El worker Python terminó (${worker.exitCode}):\n${workerLog.join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout esperando "${texto}" del worker:\n${workerLog.join("\n")}`);
}

// --- Escenarios ------------------------------------------------------------------------------
const queue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } },
});
const events = new QueueEvents(QUEUE_NAME, { connection });
const publisher = new IORedis(connection); // el API publicará aquí las cancelaciones
for (const emisor of [queue, events, publisher]) emisor.on("error", (e) => workerLog.push(`[redis] ${e.message}`));
const progressByJob = new Map();
const stalled = [];
events.on("progress", ({ jobId, data }) => {
  progressByJob.set(jobId, [...(progressByJob.get(jobId) ?? []), data]);
});
events.on("stalled", ({ jobId }) => stalled.push(jobId));

const resultados = [];
async function escenario(nombre, fn) {
  const inicio = Date.now();
  try {
    await fn();
    resultados.push({ nombre, ok: true, ms: Date.now() - inicio });
    console.log(`  OK    ${nombre} (${Date.now() - inicio} ms)`);
  } catch (error) {
    resultados.push({ nombre, ok: false });
    console.log(`  FALLA ${nombre}\n        ${String(error.message ?? error).split("\n").join("\n        ")}`);
  }
}

async function encolar(payload, { validarAntes = true } = {}) {
  if (validarAntes) validar("transcribe-job.v1", payload); // lo que hará el API Gateway
  return queue.add("transcribe", payload, { jobId: payload.jobId });
}

async function main() {
  await events.waitUntilReady();
  await esperarLinea("WORKER_READY");
  console.log("Smoke test BullMQ: Node -> Redis -> Python");

  await escenario("camino feliz: resultado y progreso cumplen el contrato", async () => {
    const payload = transcribeJob("smoke-ok.mp4");
    const job = await encolar(payload);
    const resultado = await job.waitUntilFinished(events, 20000);
    validar("transcribe-result.v1", resultado);
    assert.equal(resultado.jobId, payload.jobId);
    assert.equal(resultado.artifacts.segments.objectKey, `${payload.outputPrefix}segments.json`);
    const progreso = progressByJob.get(payload.jobId) ?? [];
    assert.ok(progreso.length >= 4, `se esperaban >=4 eventos de progreso, llegaron ${progreso.length}`);
    progreso.forEach((p) => validar("job-progress.v1", p));
    const porcentajes = progreso.map((p) => p.percent);
    assert.deepEqual(porcentajes, [...porcentajes].sort((a, b) => a - b), "el progreso no es monótono");
  });

  await escenario("error estructurado: failedReason es un JobError válido y no hay reintentos", async () => {
    const payload = transcribeJob("smoke-fail.mp4");
    const job = await encolar(payload);
    await assert.rejects(() => job.waitUntilFinished(events, 20000));
    const fallido = await queue.getJob(payload.jobId);
    const error = JSON.parse(fallido.failedReason);
    validar("job-error.v1", error);
    assert.equal(error.errorCode, "FFMPEG_FAILED");
    assert.equal(fallido.attemptsMade, 1, "con attempts:1 no debe reintentarse");
  });

  await escenario("payload inválido: el worker lo rechaza con INTERNAL (defensa en profundidad)", async () => {
    const payload = transcribeJob("smoke-ok.mp4");
    delete payload.options; // se salta la validación del productor a propósito
    const job = await encolar(payload, { validarAntes: false });
    await assert.rejects(() => job.waitUntilFinished(events, 20000));
    const fallido = await queue.getJob(payload.jobId);
    const error = JSON.parse(fallido.failedReason);
    validar("job-error.v1", error);
    assert.equal(error.errorCode, "INTERNAL");
    assert.match(error.message, /ValidationError/, "debe fallar por validación, no por otra causa");
  });

  await escenario("coerción prohibida: sizeBytes como texto lo rechaza Python (strict)", async () => {
    const payload = transcribeJob("smoke-ok.mp4");
    payload.input.sizeBytes = "1024";
    const job = await encolar(payload, { validarAntes: false });
    await assert.rejects(() => job.waitUntilFinished(events, 20000));
    const error = JSON.parse((await queue.getJob(payload.jobId)).failedReason);
    assert.equal(error.errorCode, "INTERNAL");
    assert.match(error.message, /ValidationError/, "debe fallar por validación, no por otra causa");
  });

  await escenario("idempotencia: el mismo jobId no se procesa dos veces", async () => {
    const payload = transcribeJob("smoke-ok.mp4");
    const primero = await encolar(payload);
    await primero.waitUntilFinished(events, 20000);
    const antes = (await queue.getJob(payload.jobId)).processedOn;
    const segundo = await encolar(payload);
    assert.equal(segundo.id, payload.jobId);
    await new Promise((r) => setTimeout(r, 1500));
    const despues = await queue.getJob(payload.jobId);
    assert.equal(despues.processedOn, antes, "el trabajo duplicado se volvió a procesar");
    assert.equal(await despues.getState(), "completed");
  });

  await escenario("cancelación: canal captionforge:cancel aborta el trabajo en curso (CANCELLED)", async () => {
    const payload = transcribeJob("smoke-slow.mp4");
    const job = await encolar(payload);
    const espera = job.waitUntilFinished(events, 20000);
    espera.catch(() => {}); // evita un rechazo sin manejar si la aserción de abajo falla antes
    const limite = Date.now() + 10000; // si el trabajo falla antes del primer progreso, no esperar para siempre
    while (!(progressByJob.get(payload.jobId) ?? []).length) {
      if (Date.now() > limite) throw new Error("el trabajo lento no reportó progreso en 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
    const t0 = Date.now();
    const mensaje = { schemaVersion: 1, jobId: payload.jobId };
    validar("cancel-message.v1", mensaje);
    await publisher.publish(CANCEL_CHANNEL, JSON.stringify(mensaje));
    await assert.rejects(() => espera);
    const ms = Date.now() - t0;
    const error = JSON.parse((await queue.getJob(payload.jobId)).failedReason);
    validar("job-error.v1", error);
    assert.equal(error.errorCode, "CANCELLED");
    assert.ok(ms < 3000, `la cancelación tardó ${ms} ms (máximo 3000)`);
  });

  await escenario("mensaje de cancelación malformado: el worker lo ignora y sigue vivo", async () => {
    const recibidasAntes = workerLog.filter((l) => l.startsWith("CANCEL_RECEIVED")).length;
    await publisher.publish(CANCEL_CHANNEL, "esto no es json");
    await publisher.publish(CANCEL_CHANNEL, JSON.stringify({ schemaVersion: 1, jobId: "no-es-uuid" }));
    const limite = Date.now() + 10000;
    while (workerLog.filter((l) => l.startsWith("CANCEL_IGNORED")).length < 2) {
      if (Date.now() > limite) throw new Error("el worker no registró los 2 mensajes ignorados");
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(workerLog.filter((l) => l.startsWith("CANCEL_RECEIVED")).length, recibidasAntes);
    const payload = transcribeJob("smoke-ok.mp4");
    const job = await encolar(payload);
    validar("transcribe-result.v1", await job.waitUntilFinished(events, 20000));
  });

  await escenario(`trabajo bloqueante de ${(LOCK_DURATION_MS * 3) / 1000} s fuera del bucle: el candado se renueva (sin stalled)`, async () => {
    const payload = transcribeJob("smoke-offloop.mp4");
    const job = await encolar(payload);
    validar("transcribe-result.v1", await job.waitUntilFinished(events, 40000));
    assert.equal(stalled.includes(payload.jobId), false, "BullMQ marcó el trabajo como stalled");
    assert.ok(!workerLog.some((l) => l.includes(`STALLED ${payload.jobId}`)));
  });
}

let codigo = 0;
try {
  await main();
} catch (error) {
  console.error(error);
  codigo = 1;
} finally {
  worker.kill(); // primero el proceso hijo: si un cierre de abajo fallara, no queda huérfano
  await Promise.race([workerExit, new Promise((r) => setTimeout(r, 3000))]);
  for (const paso of [
    () => queue.obliterate({ force: true }), // solo la cola única de esta ejecución
    () => events.close(),
    () => queue.close(),
    () => publisher.disconnect(),
  ]) {
    try {
      await paso();
    } catch {
      /* limpieza best-effort */
    }
  }
}

const fallos = resultados.filter((r) => !r.ok).length;
console.log(fallos === 0 && codigo === 0 ? `\nSmoke OK: ${resultados.length} escenarios.` : `\nSmoke FALLÓ: ${fallos} escenario(s).`);
if (fallos || codigo) {
  console.log("--- log del worker ---\n" + workerLog.slice(-30).join("\n"));
  process.exit(1);
}
