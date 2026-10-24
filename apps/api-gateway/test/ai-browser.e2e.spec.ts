// «Traducir» y «Doblar» (T11, ADR 0020) en un navegador real, con clics sobre el DOM contra el API de verdad (PostgreSQL, Redis, S3).
// No hay worker: la prueba hace de worker escribiendo el resultado en la base y en S3, como web-browser.e2e.spec.ts. Cubre:
//  - la confirmación de gasto en un <dialog> (cancelar no crea nada; confirmar sin clave da 409 traducido y tampoco crea nada),
//  - traducir con OpenAI (con clave) y con el motor local (sin diálogo), cancelar, y las descargas .srt/.vtt traducidos,
//  - doblar la traducción, con el aviso de frases desbordadas y las descargas de audio y video,
//  - el modo local: traducir solo con el motor local y doblar bloqueado con su explicación.
// Se omite si no hay Chrome o Edge.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { Queue } from "bullmq";
import pg from "pg";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { ExternalKeyCipher } from "../src/external-keys/external-key-crypto.js";
import { createApp } from "../src/main.js";
import { QUEUES } from "../src/queue/names.js";
import { StorageService } from "../src/storage/storage.service.js";
import { closeBrowser } from "./support/browser.js";
import { FakeProvider, type FakeProfile } from "./support/fake-provider.js";
import { createTestTenant, disposeTestTenants } from "./support/tenancy.js";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const browserPath = CANDIDATES.find((path): path is string => path !== undefined && path !== "" && existsSync(path));

const APP_SECRET = "claves-externas-ui-secreto-de-32-bytes!!";
const baseConfig = loadConfig();
const connection = { host: baseConfig.redis.host, port: baseConfig.redis.port, password: baseConfig.redis.password };
const provider = new FakeProvider();
const ANA_ID = 5_000_000 + Math.floor(Math.random() * 100_000);
const ANA: FakeProfile = { id: ANA_ID, login: `ai-${ANA_ID}`, name: "Ana Dueña", emails: [{ email: `ai-${ANA_ID}@example.com`, primary: true, verified: true }] };
const OPENAI_KEY = `sk-ui-${randomBytes(18).toString("hex")}`;
const SEGMENTS = [
  { start: 0, end: 2, text: " Hola mundo", words: null },
  { start: 2, end: 4, text: " Segunda frase", words: null },
  { start: 4, end: 6, text: " Tercera", words: null },
];
const CHARACTERS = 10 + 13 + 7; // sin los espacios de los extremos
const TRANSLATED = SEGMENTS.map((segment, index) => ({ ...segment, text: ` Translated ${index}` }));

let sessionApp: Awaited<ReturnType<typeof createApp>>;
let localApp: Awaited<ReturnType<typeof createApp>>;
let sessionBase = "";
let localBase = "";
let browser: Browser;
let owner: pg.Client;
let storage: StorageService;
let dir = "";
let translateQueue: Queue;
let dubQueue: Queue;
const queued: { queue: Queue; id: string }[] = [];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

type Dom = { document: { querySelector(s: string): { hidden: boolean; textContent: string | null; open?: boolean; disabled?: boolean; value?: string } | null } };
const press = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { click(): void }).click());
const submit = (page: Page, selector: string) => page.$eval(selector, (form) => (form as unknown as { requestSubmit(): void }).requestSubmit());
const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
const prop = <T>(page: Page, selector: string, name: string): Promise<T> => page.$eval(selector, (element, key) => (element as unknown as Record<string, T>)[key as string] as T, name) as Promise<T>;
const waitFor = (page: Page, selector: string, want: "visible" | "hidden") =>
  page.waitForFunction(
    (sel: string, state: string) => {
      const element = (globalThis as unknown as Dom).document.querySelector(sel);
      return element !== null && (state === "visible" ? !element.hidden : element.hidden);
    },
    { timeout: 20_000 },
    selector,
    want,
  );
const waitText = (page: Page, selector: string, pattern: string) =>
  page.waitForFunction((sel: string, source: string) => new RegExp(source).test((globalThis as unknown as Dom).document.querySelector(sel)?.textContent ?? ""), { timeout: 20_000 }, selector, pattern);
const waitDialog = (page: Page, open: boolean) =>
  page.waitForFunction((want: boolean) => ((globalThis as unknown as Dom).document.querySelector("#spend-confirm")?.open ?? false) === want, { timeout: 20_000 }, open);

async function open(base: string, problems: string[], failures: string[]): Promise<Page> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("captionforge_lang", "es");
    } catch {
      // sin almacenamiento
    }
  });
  page.on("pageerror", (error) => problems.push(`excepción: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`consola: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`);
  });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  return page;
}

/** Sube un video de mentira por la interfaz y deja la transcripción terminada, como lo haría el worker. */
async function transcribed(page: Page, name: string): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, randomBytes(20 * 1024));
  await page.waitForSelector("#file-input");
  await (await page.$("#file-input"))!.uploadFile(path);
  await press(page, "#start");
  await page.waitForSelector("#job-panel:not([hidden])", { timeout: 20_000 });
  const found = await owner.query<{ id: string }>(`SELECT id FROM "Job" WHERE "originalFilename" = $1 AND kind = 'TRANSCRIBE'`, [name]);
  const id = found.rows[0]!.id;
  const segmentsKey = `jobs/${id}/out/segments.json`;
  const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(SEGMENTS)), "application/json");
  await storage.putBuffer(`jobs/${id}/out/output.srt`, Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nHola\n"), "application/x-subrip");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 6,
    segmentCount: SEGMENTS.length,
    artifacts: { srt: `jobs/${id}/out/output.srt`, segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag }, waveform: `jobs/${id}/out/waveform.json` },
  };
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', stage = 'uploading', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);
  await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll("#result-segments li").length === 3, { timeout: 20_000 });
  return id;
}

const jobsOf = async (parent: string, kind: "TRANSLATE" | "DUB") =>
  (await owner.query<{ id: string; status: string; options: Record<string, unknown> }>(`SELECT id, status::text AS status, options FROM "Job" WHERE "parentJobId" = $1 AND kind = $2::"JobKind" ORDER BY "createdAt"`, [parent, kind])).rows;

async function finishTranslate(id: string, parent: string): Promise<void> {
  const key = `jobs/${id}/out/translated-segments.json`;
  const { etag } = await storage.putBuffer(key, Buffer.from(JSON.stringify(TRANSLATED)), "application/json");
  const result = { schemaVersion: 1, jobId: id, provider: "argos", sourceLanguage: "es", targetLanguage: "en", segmentCount: 3, characters: CHARACTERS, artifacts: { segments: { bucket: baseConfig.s3.bucket, objectKey: key, etag } } };
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', stage = 'uploading', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1 AND "parentJobId" = $3`, [id, JSON.stringify(result), parent]);
}

async function finishDub(id: string): Promise<void> {
  const audio = `jobs/${id}/out/dub.mp3`;
  const video = `jobs/${id}/out/dubbed.mp4`;
  await storage.putBuffer(audio, Buffer.from("ID3-audio-de-prueba"), "audio/mpeg");
  await storage.putBuffer(video, Buffer.from("video-de-prueba"), "video/mp4");
  const result = { schemaVersion: 1, jobId: id, provider: "openai", mix: "replace", segmentCount: 3, characters: CHARACTERS, overflowSegments: [1, 2], artifacts: { audio, video } };
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', stage = 'mixing', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);
}

describe.skipIf(browserPath === undefined)("traducir y doblar en un navegador real", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-ai-"));
    await provider.start();
    const sessionPort = await freePort();
    sessionBase = `http://127.0.0.1:${sessionPort}`;
    sessionApp = await createApp(
      {
        ...baseConfig,
        reaper: { ...baseConfig.reaper, intervalMs: 0 },
        auth: { ...baseConfig.auth, localMode: false, publicUrl: sessionBase, providers: { github: provider.config } },
        byok: { appSecret: APP_SECRET },
        security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
      },
      { logger: ["error"] },
    );
    await sessionApp.listen(sessionPort, "127.0.0.1");
    storage = sessionApp.get(StorageService);

    const tenant = await createTestTenant("ai-local");
    const localPort = await freePort();
    localBase = `http://127.0.0.1:${localPort}`;
    localApp = await createApp(
      {
        ...baseConfig,
        reaper: { ...baseConfig.reaper, intervalMs: 0 },
        byok: { appSecret: APP_SECRET },
        security: { ...baseConfig.security, webApiKey: tenant.apiKey, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
      },
      { logger: ["error"] },
    );
    await localApp.listen(localPort, "127.0.0.1");

    translateQueue = new Queue(QUEUES.translate, { connection });
    dubQueue = new Queue(QUEUES.dub, { connection });
    owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await owner.connect();
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  }, 90_000);

  afterAll(async () => {
    await closeBrowser(browser);
    if (owner !== undefined) {
      // Los trabajos que quedaron en las colas no deben llegar a un worker de otra prueba.
      const users = await owner.query<{ id: string; tenantId: string }>(`SELECT id, "tenantId" FROM "User" WHERE provider = 'github' AND subject = $1`, [String(ANA.id)]);
      const tenants = users.rows.map((row) => row.tenantId);
      const jobs = await owner.query<{ id: string }>(`SELECT id FROM "Job" WHERE "tenantId" = ANY($1::uuid[]) AND kind IN ('TRANSLATE', 'DUB')`, [tenants]);
      for (const { id } of jobs.rows) {
        await translateQueue.remove(id).catch(() => undefined);
        await dubQueue.remove(id).catch(() => undefined);
      }
      await owner.query(`DELETE FROM "Job" WHERE "tenantId" = ANY($1::uuid[])`, [tenants]);
      await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = ANY($1::uuid[])`, [tenants]);
      await owner.query(`DELETE FROM "Session" WHERE "userId" = ANY($1::uuid[])`, [users.rows.map((row) => row.id)]);
      await owner.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [users.rows.map((row) => row.id)]);
      await owner.query(`DELETE FROM "Tenant" WHERE id = ANY($1::uuid[])`, [tenants]);
      await owner.end();
    }
    for (const entry of queued) await entry.queue.remove(entry.id).catch(() => undefined);
    await Promise.all([translateQueue?.close(), dubQueue?.close()]);
    await Promise.all([sessionApp?.close(), localApp?.close()]);
    await provider.stop();
    await disposeTestTenants();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it("la Dueña confirma el gasto, traduce, dobla la traducción y descarga", async () => {
    provider.autoApprove = ANA;
    const problems: string[] = [];
    const failures: string[] = [];
    const page = await open(sessionBase, problems, failures);
    await page.waitForSelector("#login-github:not([hidden])");
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), press(page, "#login-github")]);
    await waitFor(page, "#account-bar", "visible");
    const tenantId = (await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "User" WHERE subject = $1`, [String(ANA.id)])).rows[0]!.tenantId;

    const parent = await transcribed(page, `ai-${randomUUID().slice(0, 8)}.mp4`);

    // ── Formularios: traducir (local y OpenAI) y doblar, con la estimación.
    await waitFor(page, "#translate-form", "visible");
    await waitFor(page, "#dub-form", "visible");
    expect(await page.$$eval("#translate-provider option", (options) => options.map((option) => (option as unknown as { value: string }).value))).toEqual(["argos", "openai"]);
    expect(await page.$$eval("#translate-target option", (options) => options.some((option) => (option as unknown as { value: string }).value === "es"))).toBe(false); // no se traduce al idioma de origen
    expect(await text(page, "#translate-estimate")).toContain("sin costo");
    await page.select("#translate-provider", "openai");
    expect(await text(page, "#translate-estimate")).toContain(`≈ ${CHARACTERS} caracteres`);
    expect(await prop<string>(page, "#dub-voice", "value")).toBe("alloy");
    expect(await prop<string | null>(page, "#dub-voice", "autocomplete")).toBe("off");

    // ── Cancelar el diálogo de gasto: no se crea nada.
    await submit(page, "#translate-form");
    await waitDialog(page, true);
    expect(await text(page, "#spend-confirm-body")).toContain(`≈ ${CHARACTERS} caracteres`);
    expect(await text(page, "#spend-confirm-body")).toContain("OpenAI");
    await press(page, "#spend-confirm-no");
    await waitDialog(page, false);
    expect(await jobsOf(parent, "TRANSLATE")).toHaveLength(0);

    // ── Confirmar sin clave guardada: 409 traducido y tampoco se crea nada.
    await submit(page, "#translate-form");
    await waitDialog(page, true);
    await press(page, "#spend-confirm-yes");
    await waitText(page, "#translate-hint", "Falta la clave del proveedor");
    expect(await jobsOf(parent, "TRANSLATE")).toHaveLength(0);
    expect(await prop<boolean>(page, "#translate-start", "disabled")).toBe(false);

    // ── Con la clave guardada, confirmar crea el trabajo de OpenAI y se puede cancelar.
    await owner.query(
      `INSERT INTO "TenantExternalKey" (id, "tenantId", provider, ciphertext, "keyVersion", last4) VALUES ($1, $2, 'openai'::"ExternalProvider", $3, 1, $4)`,
      [randomUUID(), tenantId, new ExternalKeyCipher(APP_SECRET).encrypt(OPENAI_KEY, { tenantId, provider: "openai", keyVersion: 1 }), OPENAI_KEY.slice(-4)],
    );
    await submit(page, "#translate-form");
    await waitDialog(page, true);
    await press(page, "#spend-confirm-yes");
    await waitFor(page, "#translate-panel", "visible");
    await waitText(page, "#translate-status", "En cola");
    const first = await jobsOf(parent, "TRANSLATE");
    expect(first.map((job) => [job.status, job.options.provider, job.options.targetLanguage])).toEqual([["QUEUED", "openai", "en"]]);
    queued.push({ queue: translateQueue, id: first[0]!.id });
    expect(await prop<boolean>(page, "#translate-start", "disabled")).toBe(true); // ya hay una traducción en curso
    await press(page, "#translate-cancel");
    await waitText(page, "#translate-status", "cancel");

    // ── El motor local no pregunta: crea el trabajo directo; el «worker» lo termina.
    await page.select("#translate-provider", "argos");
    await waitFor(page, "#translate-start", "visible");
    await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelector("#translate-start")?.disabled === false, { timeout: 20_000 });
    await submit(page, "#translate-form");
    await waitText(page, "#translate-status", "En cola");
    expect(await prop<boolean>(page, "#spend-confirm", "open")).toBe(false);
    const second = (await jobsOf(parent, "TRANSLATE")).find((job) => job.options.provider === "argos")!;
    queued.push({ queue: translateQueue, id: second.id });
    await finishTranslate(second.id, parent);
    await waitFor(page, "#translate-dl-srt", "visible");
    await waitFor(page, "#translate-dl-vtt", "visible");
    await waitText(page, "#translate-status", "Traducción lista");

    // ── Las descargas piden la traducción al API con clics de verdad.
    const srt = page.waitForResponse((response) => response.url().endsWith(`/v1/jobs/${second.id}/artifacts/segments`) && response.status() === 200, { timeout: 20_000 });
    await press(page, "#translate-dl-srt");
    await srt;

    // ── Doblar: la traducción terminada aparece como texto a doblar.
    expect(await page.$$eval("#dub-source option", (options) => options.map((option) => (option as unknown as { value: string }).value))).toEqual(["", second.id]);
    await page.select("#dub-source", second.id);

    // ElevenLabs no tiene clave guardada: confirmar da 409 traducido y no se crea nada.
    await page.select("#dub-provider", "elevenlabs");
    expect(await prop<string>(page, "#dub-voice", "value")).toBe("");
    expect(await prop<boolean>(page, "#dub-start", "disabled")).toBe(true); // falta escribir la voz
    await page.type("#dub-voice", "voz_de_prueba_1");
    await submit(page, "#dub-form");
    await waitDialog(page, true);
    expect(await text(page, "#spend-confirm-body")).toContain("ElevenLabs");
    await press(page, "#spend-confirm-yes");
    await waitText(page, "#dub-hint", "Falta la clave del proveedor");
    expect(await jobsOf(parent, "DUB")).toHaveLength(0);

    // OpenAI sí tiene clave: confirmar crea el doblaje de ESA traducción (su translationId llega al trabajo).
    await page.select("#dub-provider", "openai");
    await page.$eval("#dub-voice", (input) => ((input as unknown as { value: string }).value = ""));
    await page.type("#dub-voice", "nova");
    await page.select("#dub-mix", "duck");
    await submit(page, "#dub-form");
    await waitDialog(page, true);
    await press(page, "#spend-confirm-yes");
    await waitFor(page, "#dub-panel", "visible");
    await waitText(page, "#dub-status", "En cola");
    const dubs = await jobsOf(parent, "DUB");
    expect(dubs.map((job) => [job.status, job.options])).toEqual([["QUEUED", { provider: "openai", voice: "nova", mix: "duck" }]]);
    queued.push({ queue: dubQueue, id: dubs[0]!.id });
    const bull = await dubQueue.getJob(dubs[0]!.id);
    expect((bull?.data as { segments: { objectKey: string } }).segments.objectKey).toBe(`jobs/${second.id}/out/translated-segments.json`);

    // ── El «worker» termina el doblaje: aviso de desbordes y descargas de audio y video.
    await finishDub(dubs[0]!.id);
    await waitFor(page, "#dub-dl-audio", "visible");
    await waitFor(page, "#dub-dl-video", "visible");
    await waitText(page, "#dub-overflow", "2 frases");
    const audio = page.waitForResponse((response) => response.url().endsWith(`/v1/jobs/${dubs[0]!.id}/artifacts/audio`) && response.status() === 200, { timeout: 20_000 });
    await press(page, "#dub-dl-audio");
    await audio;
    const video = page.waitForResponse((response) => response.url().endsWith(`/v1/jobs/${dubs[0]!.id}/artifacts/video`) && response.status() === 200, { timeout: 20_000 });
    await press(page, "#dub-dl-video");
    await video;

    expect(problems).toEqual([]);
    // Solo fallan los 409 provocados a propósito (sin clave), la comprobación de sesión previa al inicio y el web-config.json opcional.
    expect(failures.filter((entry) => !entry.startsWith("GET /v1/me ") && !entry.startsWith("GET /v1/capabilities ") && !entry.startsWith("GET /web-config.json "))).toEqual([
      `POST /v1/jobs/${parent}/translate 409`,
      `POST /v1/jobs/${parent}/dub 409`,
    ]);
  }, 180_000);

  it("en modo local traducir usa solo el motor local y doblar queda bloqueado con su explicación", async () => {
    const problems: string[] = [];
    const failures: string[] = [];
    const page = await open(localBase, problems, failures);
    const parent = await transcribed(page, `ai-local-${randomUUID().slice(0, 8)}.mp4`);
    await waitFor(page, "#translate-form", "visible");
    await waitFor(page, "#dub-form", "visible");
    expect(await page.$$eval("#translate-provider option", (options) => options.map((option) => (option as unknown as { value: string }).value))).toEqual(["argos"]);
    await waitText(page, "#dub-hint", "modo local");
    expect(await prop<boolean>(page, "#dub-start", "disabled")).toBe(true);
    expect(await prop<boolean>(page, "#account-extkeys-toggle", "hidden")).toBe(true);

    // Traducir con el motor local no abre el diálogo de gasto.
    await submit(page, "#translate-form");
    await waitText(page, "#translate-status", "En cola");
    expect(await prop<boolean>(page, "#spend-confirm", "open")).toBe(false);
    const [job] = await jobsOf(parent, "TRANSLATE");
    expect(job!.options.provider).toBe("argos");
    queued.push({ queue: translateQueue, id: job!.id });
    // Forzar el envío de doblar tampoco llega al API.
    await submit(page, "#dub-form");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await jobsOf(parent, "DUB")).toHaveLength(0);
    expect(problems).toEqual([]);
    expect(failures).toEqual([]);
  }, 120_000);
});
