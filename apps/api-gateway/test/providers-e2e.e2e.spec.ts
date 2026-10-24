// Traducir y doblar de PUNTA A PUNTA contra proveedores falsos (ADR 0020, Punto de control: trabajos).
// API real (Nest, canal interno incluido) + Redis/BullMQ + PostgreSQL + S3 reales + el AiWorker REAL de Python (arnés apps/ai-worker/tests/
// support/e2e_worker.py) + un OpenAI/ElevenLabs de mentira por HTTP. Se comprueba el recorrido completo, los fallos con mensaje claro, que
// el worker sigue vivo tras un fallo y que la clave del espacio (un canario) no queda en ningún sitio.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LoggerService } from "@nestjs/common";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { startInternalServer } from "../src/internal/internal-server.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { StorageService } from "../src/storage/storage.service.js";
import { hashApiKey } from "../src/tenancy/api-key.js";
import { type Haystack, dirHaystacks, findLeaks, needlesFor, redisHaystacks } from "./support/leak-scan.js";
import { createTestTenant, disposeTestTenants, type TestTenant } from "./support/tenancy.js";

const APP_SECRET = "a41d6c07e3b95f28d1c4a7e0b6f93d52c8e1a4b7d0f3962e5c8b1a4d7e0f3b69";
const TOKEN = "9e2c6a41d07b83e5a1c4f6d2b9087e53c1a4d6f8b20e7395a1c4d6f8e0b2a497";
const CANARY = `sk-canario-${randomBytes(20).toString("hex")}`;
const CSRF = { "x-requested-with": "captionforge" };

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, "..", "..", "..");
const workerDir = join(raiz, "apps", "ai-worker");
const HARNESS = join(workerDir, "tests", "support", "e2e_worker.py");
const CLIP = join(raiz, "legacy", "tests", "fixtures", "tiny_test_clip.mp4");
const WITH_ENV = join(raiz, "apps", "api-gateway", "scripts", "with-env.mjs");

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
const NEEDLES = needlesFor(CANARY);
const apiLogs: string[] = [];
const providerCalls: { path: string; authorization: string | undefined; xiKey: string | undefined; body: Record<string, unknown> }[] = [];
let providerMode: "ok" | "quota" = "ok";

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

let dbOwner: pg.Client;
let tenant: TestTenant;
let ownerId = "";
let ownerCookie = "";
let app: Awaited<ReturnType<typeof createApp>>;
let apiUrl = "";
let internalUrl = "";
let internalServer: http.Server;
let provider: http.Server;
let providerUrl = "";
let toneMp3: Buffer;
let worker: ChildProcess | undefined;
let workerOut = "";
let workDir = "";
let redis: Redis;
let prisma: PrismaService;
let storage: StorageService;
const jobIds: string[] = [];
const storageKeys: string[] = [];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

function startProvider(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      providerCalls.push({ path: request.url ?? "", authorization: request.headers.authorization, xiKey: request.headers["xi-api-key"] as string | undefined, body });
      if (providerMode === "quota") {
        response.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Billing hard limit reached for ${request.headers.authorization}` } }));
        return;
      }
      if (request.url?.startsWith("/v1/chat/completions")) {
        const messages = body.messages as { content: string }[];
        const asked = JSON.parse(messages[messages.length - 1]!.content) as { target: string; texts: string[] };
        const translations = asked.texts.map((text) => `[${asked.target}] ${text}`);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }));
        return;
      }
      response.writeHead(200, { "content-type": "audio/mpeg", "content-length": toneMp3.length }).end(toneMp3);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${apiUrl}${path}`, { method: "POST", headers: { ...CSRF, "content-type": "application/json", cookie: ownerCookie }, body: JSON.stringify(body) });
const get = (path: string): Promise<Response> => fetch(`${apiUrl}${path}`, { headers: { cookie: ownerCookie } });

interface View {
  id: string;
  status: string;
  error: { code: string; message: string | null } | null;
  result: { artifacts: string[]; overflowSegments?: number[] } | null;
}

async function untilDone(id: string, timeoutMs = 90_000): Promise<View> {
  const deadline = Date.now() + timeoutMs;
  let view: View | undefined;
  while (Date.now() < deadline) {
    view = (await (await get(`/v1/jobs/${id}`)).json()) as View;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`el trabajo ${id} no terminó: ${JSON.stringify(view)}; salida del worker: ${workerOut.slice(-1500)}`);
}

/** Una transcripción terminada, como la dejaría el worker, con el video de prueba real y tres frases en sus primeros segundos. */
async function completedTranscription(): Promise<{ id: string }> {
  const id = randomUUID();
  jobIds.push(id);
  const inputKey = `jobs/${id}/input.mp4`;
  const segmentsKey = `jobs/${id}/out/segments.json`;
  storageKeys.push(inputKey, segmentsKey);
  const video = readFileSync(CLIP);
  await storage.putBuffer(inputKey, video, "video/mp4");
  const segments = [
    { start: 0.5, end: 1.6, text: " Hola a todos", words: null },
    { start: 2.0, end: 3.2, text: " Bienvenidos al curso", words: null },
    { start: 4.0, end: 5.2, text: " Empecemos ya", words: null },
  ];
  const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(segments)), "application/json");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 10,
    segmentCount: segments.length,
    artifacts: { srt: `jobs/${id}/out/output.srt`, segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag }, waveform: `jobs/${id}/out/waveform.json` },
  };
  await dbOwner.query(
    `INSERT INTO "Job" (id, "tenantId", kind, status, percent, "inputBucket", "inputKey", "originalFilename", "contentType", "sizeBytes", "outputPrefix", options, result, "finishedAt", "updatedAt")
     VALUES ($1, $2, 'TRANSCRIBE', 'COMPLETED', 100, $3, $4, 'curso.mp4', 'video/mp4', $5, $6, '{}'::jsonb, $7::jsonb, now(), now())`,
    [id, tenant.id, baseConfig.s3.bucket, inputKey, video.length, `jobs/${id}/out/`, JSON.stringify(result)],
  );
  return { id };
}

function startWorker(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const command = [WITH_ENV, "worker", "--", process.platform === "win32" ? `"${python}"` : (python as string), "-I", HARNESS];
    const child = spawn(process.execPath, command, {
      cwd: workerDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: join(workerDir, "src"),
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        API_INTERNAL_URL: internalUrl,
        WORKER_INTERNAL_TOKEN: TOKEN,
        WORK_DIR: workDir,
        FAKE_PROVIDER_URL: providerUrl,
        HEARTBEAT_SECONDS: "5",
      },
    });
    const timer = setTimeout(() => reject(new Error(`el worker no llegó a READY: ${workerOut.slice(-1500)}`)), 60_000);
    const onData = (chunk: Buffer): void => {
      workerOut += chunk.toString("utf8");
      if (workerOut.includes("READY")) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`el worker terminó (${code}): ${workerOut.slice(-1500)}`));
    });
  });
}

beforeAll(async () => {
  if (!python) {
    if (inCi) throw new Error("falta el Python del worker: la E2E de proveedores no puede omitirse en CI");
    console.warn("[providers-e2e] SIN Python del worker: la prueba se omite (en CI esto es un error).");
    return;
  }
  dbOwner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await dbOwner.connect();
  tenant = await createTestTenant("proveedores");
  ownerId = randomUUID();
  await dbOwner.query(`INSERT INTO "User" (id, "tenantId", name, provider, subject) VALUES ($1, $2, 'dueno-proveedores', 'github', $3)`, [ownerId, tenant.id, `prov-${ownerId}`]);
  await dbOwner.query(`INSERT INTO "Membership" ("userId", "tenantId", role) VALUES ($1, $2, 'OWNER'::"Role")`, [ownerId, tenant.id]);
  const token = randomBytes(32).toString("base64url");
  await dbOwner.query(`INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`, [randomUUID(), ownerId, hashApiKey(token)]);
  ownerCookie = `cf_session=${token}`;

  app = await createApp(
    {
      ...baseConfig,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      auth: { ...baseConfig.auth, localMode: false },
      byok: { ...baseConfig.byok, appSecret: APP_SECRET },
      security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
    },
    { logger: new CapturingLogger() },
  );
  await app.listen(0, "127.0.0.1");
  apiUrl = await app.getUrl();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  const port = await freePort();
  internalServer = await startInternalServer(app, { host: "127.0.0.1", port, workerToken: TOKEN, rateLimitPerMinute: 10_000 });
  internalUrl = `http://127.0.0.1:${port}`;

  const tone = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", "-ac", "1", "-ar", "24000", "-f", "mp3", "-"], { maxBuffer: 1 << 24 });
  if (tone.status !== 0) throw new Error("ffmpeg no está disponible en el PATH para generar la voz de prueba");
  toneMp3 = tone.stdout;
  provider = await startProvider();
  providerUrl = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`;
  workDir = mkdtempSync(join(tmpdir(), "cf-e2e-work-"));
  redis = new Redis({ host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password, maxRetriesPerRequest: 2 });

  // El Dueño guarda su clave (el canario) por la API pública: desde aquí solo existe cifrada.
  const put = await fetch(`${apiUrl}/v1/workspaces/current/external-keys/openai`, {
    method: "PUT",
    headers: { ...CSRF, "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ key: CANARY }),
  });
  expect(put.status).toBe(200);
  worker = await startWorker();
}, 150_000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    worker.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { worker?.kill(); resolve(); }, 20_000);
      worker!.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (!python) return;
  redis?.disconnect();
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await new Promise<void>((resolve) => internalServer?.close(() => resolve()));
  const children = await dbOwner.query(`SELECT id FROM "Job" WHERE "tenantId" = $1`, [tenant.id]);
  const all = [...new Set([...jobIds, ...children.rows.map((row: { id: string }) => row.id)])];
  await app?.close();
  await dbOwner.query(`DELETE FROM "Job" WHERE id = ANY($1::uuid[]) AND kind <> 'TRANSCRIBE'`, [all]);
  await dbOwner.query(`DELETE FROM "Job" WHERE id = ANY($1::uuid[])`, [all]);
  for (const key of [...storageKeys, ...all.flatMap((id) => [`jobs/${id}/out/translated-segments.json`, `jobs/${id}/out/dub.mp3`, `jobs/${id}/out/dubbed.mp4`])]) {
    await storage?.delete(key).catch(() => undefined);
  }
  await dbOwner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenant.id]);
  await dbOwner.query(`DELETE FROM "Session" WHERE "userId" = $1`, [ownerId]);
  await dbOwner.query(`DELETE FROM "User" WHERE id = $1`, [ownerId]);
  await disposeTestTenants();
  await dbOwner.end();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("el entorno de la prueba", () => {
  it("hay un Python con las dependencias del worker (en CI es obligatorio)", () => {
    if (inCi) expect(python).toBeDefined();
    if (!python) console.warn("[providers-e2e] sin Python del worker: las pruebas de recorrido se omiten.");
  });
});

describe.skipIf(!python)("traducir y doblar de punta a punta contra proveedores falsos", { timeout: 120_000 }, () => {
  let parent = "";
  let translation = "";

  it("traduce con OpenAI usando la clave del espacio y entrega los subtítulos traducidos con sus tiempos", async () => {
    parent = (await completedTranscription()).id;
    const started = await post(`/v1/jobs/${parent}/translate`, { provider: "openai", targetLanguage: "en" });
    expect(started.status).toBe(202);
    translation = ((await started.json()) as { id: string }).id;
    const done = await untilDone(translation);
    expect(done.status, JSON.stringify(done.error)).toBe("COMPLETED");
    expect(done.result?.artifacts).toEqual(["segments"]);

    const segments = (await (await get(`/v1/jobs/${translation}/artifacts/segments`)).json()) as { start: number; end: number; text: string }[];
    expect(segments.map((s) => s.text)).toEqual(["[en] Hola a todos", "[en] Bienvenidos al curso", "[en] Empecemos ya"]);
    expect(segments.map((s) => [s.start, s.end])).toEqual([[0.5, 1.6], [2.0, 3.2], [4.0, 5.2]]);
    // El proveedor recibió EXACTAMENTE la clave del espacio (no un marcador): el recorrido por el canal interno funcionó.
    expect(providerCalls.some((call) => call.authorization === `Bearer ${CANARY}` && call.path === "/v1/chat/completions")).toBe(true);
  });

  it("dobla la traducción con la voz de OpenAI y mezcla con el video: audio y MP4 descargables", async () => {
    const started = await post(`/v1/jobs/${parent}/dub`, { provider: "openai", voice: "alloy", mix: "duck", translationId: translation });
    expect(started.status).toBe(202);
    const id = ((await started.json()) as { id: string }).id;
    const done = await untilDone(id);
    expect(done.status, JSON.stringify(done.error)).toBe("COMPLETED");
    expect(done.result?.artifacts.sort()).toEqual(["audio", "video"]);
    expect(done.result?.overflowSegments).toEqual([]);

    const audio = Buffer.from(await (await get(`/v1/jobs/${id}/artifacts/audio`)).arrayBuffer());
    expect(audio[0] === 0xff || audio.subarray(0, 3).toString() === "ID3").toBe(true);
    const video = Buffer.from(await (await get(`/v1/jobs/${id}/artifacts/video`)).arrayBuffer());
    expect(video.subarray(4, 8).toString()).toBe("ftyp");
    const speech = providerCalls.filter((call) => call.path === "/v1/audio/speech");
    expect(speech.map((call) => call.body.input)).toEqual(["[en] Hola a todos", "[en] Bienvenidos al curso", "[en] Empecemos ya"]);
    expect(speech.every((call) => call.authorization === `Bearer ${CANARY}`)).toBe(true);
  });

  it("un proveedor sin saldo falla ese trabajo con un mensaje claro y SIN texto del proveedor; el worker sigue vivo y procesa el siguiente", async () => {
    providerMode = "quota";
    const second = (await completedTranscription()).id;
    const failing = await post(`/v1/jobs/${second}/dub`, { provider: "openai", voice: "alloy" });
    expect(failing.status).toBe(202);
    const failedView = await untilDone(((await failing.json()) as { id: string }).id);
    expect(failedView.status).toBe("FAILED");
    expect(failedView.error?.code).toBe("EXTERNAL_QUOTA_EXCEEDED");
    expect(failedView.error?.message).toMatch(/saldo|cuota/i);
    expect(JSON.stringify(failedView)).not.toMatch(/Billing hard limit|Bearer/);

    providerMode = "ok";
    expect(worker?.exitCode, "el worker no debe haberse caído").toBeNull();
    const next = await post(`/v1/jobs/${second}/translate`, { provider: "openai", targetLanguage: "fr" });
    const nextView = await untilDone(((await next.json()) as { id: string }).id);
    expect(nextView.status, JSON.stringify(nextView.error)).toBe("COMPLETED");
    expect(worker?.exitCode).toBeNull();
  });

  it("sin la clave del espacio el API responde 409 antes de encolar y no llama al proveedor", async () => {
    const third = (await completedTranscription()).id;
    const before = providerCalls.length;
    await dbOwner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenant.id]);
    const response = await post(`/v1/jobs/${third}/translate`, { provider: "openai", targetLanguage: "en" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "external_key_missing" });
    expect(providerCalls.length).toBe(before);
  });

  it("CERO FUGAS: el canario no aparece en Redis, registros del API, salida del worker, /work ni la base", async () => {
    const jobs = await dbOwner.query(`SELECT row_to_json(j)::text AS row FROM "Job" j WHERE j."tenantId" = $1`, [tenant.id]);
    const haystacks: Haystack[] = [
      ...(await redisHaystacks(redis)),
      { where: "registros del API", text: apiLogs.join("\n") },
      { where: "salida del worker", text: workerOut },
      ...dirHaystacks(workDir),
      ...jobs.rows.map((row: { row: string }) => ({ where: "db:Job", text: row.row })),
    ];
    // La búsqueda no es sobre el vacío: el trabajo pasó por todos esos sitios.
    expect(haystacks.some((h) => h.where.startsWith("redis:bull:captionforge.dub"))).toBe(true);
    expect(apiLogs.some((line) => line.includes("Clave openai entregada al worker"))).toBe(true);
    expect(workerOut).toContain("READY");
    expect(findLeaks(haystacks, NEEDLES)).toEqual([]);
  });

  it("el worker termina limpiamente cuando se le pide y no deja archivos en /work", async () => {
    worker?.stdin?.end();
    await new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
    expect(workerOut).toContain("STOPPED");
    expect(dirHaystacks(workDir).filter((h) => h.where.endsWith(".mp3") || h.where.endsWith(".wav") || h.where.endsWith(".mp4"))).toEqual([]);
  });
});
