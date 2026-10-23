// Prueba canario de claves externas (ADR 0020, T5): una clave señuelo `sk-canario-…` recorre TODO el camino real (guardado por el
// Dueño → cifrado en base → entrega por el canal interno → uso por el worker contra un proveedor) y después se busca, a
// propósito y sin piedad, en cada sitio donde un descuido podría dejarla en claro: Redis (bull:*, cuotas, cancelaciones), los
// registros del API, la salida y los registros del worker, la carpeta de trabajo (/work) y las filas de la base.
// Si el canario aparece en claro (o en una forma trivial: base64, URL, un trozo), la prueba FALLA EN ROJO.
//
// El worker es la sonda de Python `apps/ai-worker/tests/support/canary_probe.py`: usa el cliente real (`ExternalKeyClient`), el
// filtro real de registros y `JobFailure`. Hasta la Fase 3 el worker no tiene consumidor TRANSLATE/DUB; la sonda hace lo que ese
// consumidor hará con la clave. PostgreSQL y Redis reales (npm run infra:up) y Python con las dependencias del worker.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LoggerService } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { startInternalServer } from "../src/internal/internal-server.js";
import { hashApiKey } from "../src/tenancy/api-key.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const APP_SECRET = "5b7e1c93a2d84f60b1e97c35d8a20f46c3b95e17a4d68f02b7c1e93a5d84f60b";
const TOKEN = "d41f9a6c27b8e035f1a49c62d8b07e3a95c1f4d60b28e7a3c91d5f8b02e6a47c";
const CANARY = `sk-canario-${randomBytes(20).toString("hex")}`;
const CSRF = { "x-requested-with": "captionforge" };

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, "..", "..", "..");
const workerDir = join(raiz, "apps", "ai-worker");
const PROBE = join(workerDir, "tests", "support", "canary_probe.py");

/** Lo que busca el escáner: el canario y las formas triviales en que un descuido lo dejaría (trozo, base64, URL, hex). */
const NEEDLES: { name: string; value: string }[] = [
  { name: "clave completa", value: CANARY },
  { name: "trozo central", value: CANARY.slice(3, 28) },
  { name: "sufijo", value: CANARY.slice(-16) },
  { name: "base64", value: Buffer.from(CANARY).toString("base64").replace(/=+$/, "") },
  { name: "base64 con desfase 1", value: Buffer.from(`x${CANARY}`).toString("base64").slice(2).replace(/=+$/, "") },
  { name: "base64 con desfase 2", value: Buffer.from(`xx${CANARY}`).toString("base64").slice(3).replace(/=+$/, "") },
  { name: "URL codificada", value: encodeURIComponent(CANARY) },
  { name: "hexadecimal", value: Buffer.from(CANARY).toString("hex") },
];

function findPython(): string | undefined {
  return [
    process.env.AI_WORKER_PYTHON,
    join(workerDir, ".venv", "Scripts", "python.exe"),
    join(workerDir, ".venv", "bin", "python"),
    join(raiz, ".venv", "Scripts", "python.exe"),
    join(raiz, ".venv", "bin", "python"),
  ].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
}
const python = findPython();
const inCi = Boolean(process.env.CI);

const baseConfig = loadConfig();
let dbOwner: pg.Client;
let tenant: TestTenant;
let ownerId = "";
let ownerCookie = "";
let apiUrl = "";
let internalUrl = "";
let app: Awaited<ReturnType<typeof createApp>>;
let internalServer: http.Server;
let provider: http.Server;
let providerUrl = "";
let providerAuthorizations: string[] = [];
let workDir = "";
let redis: Redis;
let queue: Queue;
const apiLogs: string[] = [];
const sessions: string[] = [];
const jobIds: string[] = [];

/** Un registro de Nest que guarda TODO lo que el API escribe (todos los niveles), con sus argumentos. */
class CapturingLogger implements LoggerService {
  private push(level: string, message: unknown, params: unknown[]): void {
    apiLogs.push(`${level} ${typeof message === "string" ? message : JSON.stringify(message)} ${params.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`);
  }
  log(message: unknown, ...params: unknown[]): void { this.push("log", message, params); }
  error(message: unknown, ...params: unknown[]): void { this.push("error", message, params); }
  warn(message: unknown, ...params: unknown[]): void { this.push("warn", message, params); }
  debug(message: unknown, ...params: unknown[]): void { this.push("debug", message, params); }
  verbose(message: unknown, ...params: unknown[]): void { this.push("verbose", message, params); }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Proveedor de mentira: rechaza con 401 y repite la clave en su mensaje, como hace OpenAI ("Incorrect API key provided: sk-…"). */
function startFakeProvider(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    providerAuthorizations.push(String(request.headers.authorization));
    const presented = String(request.headers.authorization).replace(/^Bearer /, "");
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Incorrect API key provided: ${presented}.`, type: "invalid_request_error" } }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProbe(jobId: string, extraEnv: Record<string, string> = {}): Promise<ProbeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(python as string, ["-I", PROBE], {
      cwd: workerDir,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        PYTHONPATH: join(workerDir, "src"),
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        API_INTERNAL_URL: internalUrl,
        WORKER_INTERNAL_TOKEN: TOKEN,
        JOB_ID: jobId,
        PROVIDER: "openai",
        WORK_DIR: workDir,
        FAKE_PROVIDER_URL: providerUrl,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function insertRunningJob(): Promise<string> {
  const id = randomUUID();
  await dbOwner.query(
    `INSERT INTO "Job" (id, "tenantId", kind, status, "inputBucket", "inputKey", "originalFilename", "contentType", "sizeBytes", "outputPrefix", options, "updatedAt")
     VALUES ($1, $2, 'TRANSLATE'::"JobKind", 'RUNNING'::"JobStatus", 'b', 'k', 'v.mp4', 'video/mp4', 1, $3, $4, now())`,
    [id, tenant.id, `jobs/${id}/out/`, JSON.stringify({ provider: "openai", targetLanguage: "es" })],
  );
  jobIds.push(id);
  return id;
}

/** El mismo mensaje que el worker enviaría por BullMQ para este trabajo: ids y opciones, jamás la clave. */
async function enqueue(jobId: string): Promise<void> {
  await queue.add("translate", { jobId, tenantId: tenant.id, kind: "TRANSLATE", options: { provider: "openai", targetLanguage: "es" } }, { jobId });
}

/** Todas las claves de Redis serializadas con DUMP (sirve para cualquier tipo: cadena, hash, lista, flujo, conjunto ordenado). */
async function redisHaystacks(): Promise<{ where: string; text: string }[]> {
  const names: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "COUNT", 500);
    names.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  const found: { where: string; text: string }[] = [];
  for (const name of names) {
    const dump = (await redis.callBuffer("DUMP", name)) as Buffer | null;
    found.push({ where: `redis:${name}`, text: Buffer.concat([Buffer.from(name), dump ?? Buffer.alloc(0)]).toString("latin1") });
  }
  return found;
}

function workDirHaystacks(): { where: string; text: string }[] {
  const found: { where: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      found.push({ where: `work:${path.slice(workDir.length)}`, text: path.slice(workDir.length) }); // también los NOMBRES
      if (statSync(path).isDirectory()) walk(path);
      else found.push({ where: `work:${path.slice(workDir.length)}`, text: readFileSync(path).toString("latin1") });
    }
  };
  walk(workDir);
  return found;
}

async function databaseHaystacks(): Promise<{ where: string; text: string }[]> {
  const jobs = await dbOwner.query(`SELECT row_to_json(j)::text AS row FROM "Job" j WHERE j."tenantId" = $1`, [tenant.id]);
  const events = await dbOwner.query(`SELECT row_to_json(e)::text AS row FROM "AuditEvent" e WHERE e."tenantId" = $1`, [tenant.id]).catch(() => ({ rows: [] as { row: string }[] }));
  return [
    ...jobs.rows.map((row: { row: string }) => ({ where: "db:Job", text: row.row })),
    ...events.rows.map((row: { row: string }) => ({ where: "db:AuditEvent", text: row.row })),
  ];
}

/** Devuelve cada lugar donde aparece alguna de las formas del canario. Vacío = cero fugas. */
function findLeaks(haystacks: { where: string; text: string }[]): string[] {
  const leaks: string[] = [];
  for (const { where, text } of haystacks) {
    for (const needle of NEEDLES) {
      if (text.includes(needle.value)) leaks.push(`${where} contiene ${needle.name}`);
    }
  }
  return leaks;
}

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

beforeAll(async () => {
  dbOwner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await dbOwner.connect();
  tenant = await createTestTenant("canario");
  ownerId = randomUUID();
  await dbOwner.query(`INSERT INTO "User" (id, "tenantId", name, provider, subject) VALUES ($1, $2, 'dueno-canario', 'github', $3)`, [ownerId, tenant.id, `canario-${ownerId}`]);
  await dbOwner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, 'OWNER'::"Role")`, [ownerId, tenant.id]);
  const token = randomBytes(32).toString("base64url");
  await dbOwner.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [randomUUID(), ownerId, hashApiKey(token)]);
  sessions.push(token);
  ownerCookie = `cf_session=${token}`;

  app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      auth: { ...baseConfig.auth, localMode: false },
      byok: { appSecret: APP_SECRET },
      security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
    },
    { logger: new CapturingLogger() },
  );
  await app.listen(0, "127.0.0.1");
  apiUrl = await app.getUrl();
  const port = await freePort();
  internalServer = await startInternalServer(app, { host: "127.0.0.1", port, workerToken: TOKEN, rateLimitPerMinute: 10_000 });
  internalUrl = `http://127.0.0.1:${port}`;

  provider = await startFakeProvider();
  providerUrl = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1/chat/completions`;
  workDir = mkdtempSync(join(tmpdir(), "cf-canary-work-"));
  redis = new Redis({ host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password, maxRetriesPerRequest: 2 });
  queue = new Queue(`captionforge.translate.canary-${randomUUID()}`, { connection: { host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password } });

  // El Dueño guarda el canario por la API pública: desde aquí solo existe cifrado en la base.
  const put = await fetch(`${apiUrl}/v1/workspaces/current/external-keys/openai`, {
    method: "PUT",
    headers: { ...CSRF, "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ key: CANARY }),
  });
  expect(put.status).toBe(200);
}, 90_000);

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  redis?.disconnect();
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await new Promise<void>((resolve) => internalServer?.close(() => resolve()));
  await app?.close();
  if (jobIds.length > 0) await dbOwner.query(`DELETE FROM "Job" WHERE id = ANY($1::uuid[])`, [jobIds]);
  await dbOwner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenant.id]);
  await dbOwner.query(`DELETE FROM "Session" WHERE "userId" = $1`, [ownerId]);
  await dbOwner.query(`DELETE FROM "User" WHERE id = $1`, [ownerId]);
  await disposeTestTenants();
  await dbOwner.end();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("el entorno de la prueba", () => {
  it("hay un Python con las dependencias del worker (en CI es obligatorio: sin él, la prueba canario no se puede saltar)", () => {
    if (inCi) expect(python, "falta el Python del worker: la prueba canario no puede omitirse en CI").toBeDefined();
    if (!python) console.warn("[canario] SIN Python del worker: las pruebas de recorrido se omiten (en CI esto es un error).");
  });
});

describe.skipIf(!python)("prueba canario: el recorrido completo de la clave", () => {
  let jobId = "";
  let run: ProbeRun;
  let haystacks: { where: string; text: string }[] = [];

  beforeAll(async () => {
    // El sitio de partida SÍ contiene la clave, cifrada: si el escáner la encuentra en la base antes de empezar, el escáner está roto.
    jobId = await insertRunningJob();
    await enqueue(jobId);
    run = await runProbe(jobId);
    const redisLines = await redisHaystacks();
    haystacks = [
      ...redisLines,
      { where: "registros del API", text: apiLogs.join("\n") },
      { where: "salida del worker (stdout)", text: run.stdout },
      { where: "salida del worker (stderr / registros)", text: run.stderr },
      ...workDirHaystacks(),
      ...(await databaseHaystacks()),
    ];
  }, 120_000);

  it("el recorrido ocurrió de verdad: el worker obtuvo la clave real y el proveedor la recibió", () => {
    expect(run.code, run.stderr.slice(0, 2000)).toBe(0);
    expect(run.stdout).toContain("RESULT ");
    // Que el proveedor haya visto EXACTAMENTE el canario prueba que el worker tuvo la clave real (no un marcador censurado).
    expect(providerAuthorizations).toContain(`Bearer ${CANARY}`);
    const result = JSON.parse(run.stdout.split("RESULT ")[1]!.split("\n")[0]!) as { fingerprint: string };
    expect(result.fingerprint).toBe(fingerprint(CANARY));
  });

  it("la búsqueda no es sobre el vacío: Redis, los registros y la carpeta de trabajo tienen contenido real", async () => {
    const redisLines = haystacks.filter((h) => h.where.startsWith("redis:"));
    expect(redisLines.some((h) => h.where.includes("bull:"))).toBe(true); // el mensaje de la cola existe
    expect(redisLines.some((h) => h.text.includes(jobId))).toBe(true); // y es el de ESTE trabajo
    expect(apiLogs.some((line) => line.includes(jobId))).toBe(true); // el API registró la entrega (sin el valor)
    expect(run.stderr).toContain("clave obtenida"); // el worker registró
    expect(haystacks.some((h) => h.where.startsWith("work:") && h.text.includes("translated"))).toBe(true);
  });

  it("el worker intentó filtrar la clave a propósito y el filtro la censuró en sus propios registros", () => {
    expect(run.stderr).toContain("[CLAVE-OCULTA]");
    expect(run.stderr).toContain("fallo simulado con la clave dentro de la traza");
    expect(run.stdout).toContain("FAILURE_MESSAGE=");
    expect(run.stdout).toContain("[CLAVE-OCULTA]"); // el error del proveedor que ve la persona no lleva la clave
  });

  it("CERO FUGAS: el canario no aparece en Redis (bull:*), registros del API, registros del worker, /work ni la base", () => {
    expect(findLeaks(haystacks)).toEqual([]);
  });

  it("en la base la clave solo existe cifrada", async () => {
    const stored = await dbOwner.query(`SELECT ciphertext FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenant.id]);
    expect(stored.rows).toHaveLength(1);
    expect(findLeaks([{ where: "db:TenantExternalKey", text: stored.rows[0].ciphertext }])).toEqual([]);
  });

  it("una excepción sin capturar con la clave dentro tampoco la deja en la salida del worker", async () => {
    const crashJob = await insertRunningJob();
    const crash = await runProbe(crashJob, { MODE: "crash" });
    expect(crash.code).not.toBe(0); // la excepción llegó hasta el intérprete
    expect(crash.stderr).toContain("RuntimeError");
    expect(findLeaks([{ where: "crash stdout", text: crash.stdout }, { where: "crash stderr", text: crash.stderr }])).toEqual([]);
  }, 60_000);

  it("el worker no obtiene la clave de un trabajo que no es suyo: otro proveedor o un trabajo terminado no entregan nada", async () => {
    const done = await insertRunningJob();
    await dbOwner.query(`UPDATE "Job" SET status = 'COMPLETED'::"JobStatus" WHERE id = $1`, [done]);
    const refused = await runProbe(done);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).not.toContain("RESULT ");
    expect(findLeaks([{ where: "rechazo stdout", text: refused.stdout }, { where: "rechazo stderr", text: refused.stderr }])).toEqual([]);
  }, 60_000);
});

describe.skipIf(!python)("control negativo: el escáner detecta una fuga cuando existe", () => {
  it("si el worker imprime o guarda la clave sin pasar por el filtro, la prueba lo ve (si no, la prueba canario no vale nada)", async () => {
    const jobId = await insertRunningJob();
    const leaking = await runProbe(jobId, { LEAK: "1" });
    expect(leaking.code).toBe(0);
    const leaks = findLeaks([{ where: "stdout", text: leaking.stdout }, ...workDirHaystacks()]);
    expect(leaks.some((leak) => leak.startsWith("stdout contiene clave completa"))).toBe(true);
    expect(leaks.some((leak) => leak.includes("fuga.txt") && leak.includes("clave completa"))).toBe(true);
  }, 60_000);

  it("el escáner detecta el canario en cada forma trivial: trozo, base64, URL y hexadecimal", () => {
    for (const needle of NEEDLES) {
      expect(findLeaks([{ where: "prueba", text: `registro con ${needle.value} dentro` }]).length, needle.name).toBeGreaterThan(0);
    }
    expect(findLeaks([{ where: "limpio", text: "nada que ver aquí [CLAVE-OCULTA]" }])).toEqual([]);
  });

  it("el escáner de Redis ve una clave filtrada en una cola (si BullMQ llevara la clave, la prueba fallaría)", async () => {
    const poisoned = `captionforge:canario:envenenado:${randomUUID()}`;
    await redis.set(poisoned, JSON.stringify({ jobId: "x", options: { apiKey: CANARY } }), "EX", 60);
    try {
      const leaks = findLeaks(await redisHaystacks());
      expect(leaks.some((leak) => leak.includes(poisoned) && leak.includes("clave completa"))).toBe(true);
    } finally {
      await redis.del(poisoned);
    }
  }, 60_000);
});
