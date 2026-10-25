// Acciones del asistente (v1.3.1, ADR 0028) en un navegador real: la IA (falsa, en 127.0.0.1) PROPONE; nada se ejecuta hasta que la persona
// pulsa «Aplicar». Se omite si no hay Chrome o Edge.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import pg from "pg";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { StorageService } from "../src/storage/storage.service.js";
import { closeBrowser } from "./support/browser.js";
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

const cleanEnv = { ...process.env, ALLOW_PRIVATE_BASE_URLS: "true" } as NodeJS.ProcessEnv;
for (const name of ["ALLOWED_HOSTS", "ALLOWED_ORIGINS", "PUBLIC_URL", "LOCAL_MODE"]) delete cleanEnv[name];
const baseConfig = loadConfig(cleanEnv);

const KEY = "test-key-12345678";
const SEGMENTS = [{ start: 0, end: 2, text: " Hola mundo", words: null }];

const call = (name: string, args: unknown) => ({ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } });

/** La IA falsa decide por lo que dice la persona. */
function fakeAi(userText: string): { content: string | null; tool_calls?: unknown[] } {
  if (userText.includes("traduce")) return { content: "Te lo traduzco.", tool_calls: [call("translate", { targetLanguage: "en", provider: "argos" })] };
  if (userText.includes("doblar")) return { content: null, tool_calls: [call("go_to_step", { step: "dub" })] };
  if (userText.includes("quema")) return { content: "Creo el video.", tool_calls: [call("burn", {})] };
  if (userText.includes("malo")) return { content: "Hecho.", tool_calls: [call("delete_everything", {}), call("translate", { targetLanguage: "en; DROP", provider: "argos" })] };
  return { content: "Sin acciones." };
}

let app: Awaited<ReturnType<typeof createApp>>;
let ai: Server;
let aiPort = 0;
let base = "";
let browser: Browser;
let owner: pg.Client;
let storage: StorageService;
let dir = "";
const proposals: string[] = [];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

type Dom = { document: { querySelector(s: string): { hidden: boolean; textContent: string | null; closest(s: string): unknown } | null; querySelectorAll(s: string): { length: number }; activeElement: { closest(s: string): unknown } | null } };
const press = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { click(): void }).click());
const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
const count = (page: Page, selector: string) => page.evaluate((sel) => (globalThis as unknown as Dom).document.querySelectorAll(sel).length, selector);
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
const waitCount = (page: Page, selector: string, n: number) => page.waitForFunction((sel: string, want: number) => (globalThis as unknown as Dom).document.querySelectorAll(sel).length === want, { timeout: 20_000 }, selector, n);

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    request.on("end", () => resolve(data));
  });

async function open(problems: string[]): Promise<Page> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("captionforge_lang", "es");
      localStorage.setItem("cf-tour", "1");
    } catch {
      // sin almacenamiento
    }
  });
  page.on("pageerror", (error) => problems.push(`excepción: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`consola: ${message.text()}`);
  });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  return page;
}

async function configure(page: Page): Promise<void> {
  await press(page, "#assistant-open");
  await waitFor(page, "#assistant", "visible");
  await page.select("#assistant-service", "custom");
  await waitFor(page, "#assistant-url", "visible");
  await page.type("#assistant-url", `http://127.0.0.1:${aiPort}/v1`);
  await page.type("#assistant-key", KEY);
  await press(page, "#assistant-save");
  await waitText(page, "#assistant-status", "Guardado en este navegador");
}

/** Sube un archivo de mentira por la interfaz y deja la transcripción terminada, como lo haría el worker. */
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
  await storage.putBuffer(`jobs/${id}/out/output.srt`, Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nHola mundo\n"), "application/x-subrip");
  const result = {
    schemaVersion: 1,
    jobId: id,
    detectedLanguage: "es",
    device: "cpu",
    durationSeconds: 2,
    segmentCount: 1,
    artifacts: { srt: `jobs/${id}/out/output.srt`, segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag }, waveform: `jobs/${id}/out/waveform.json` },
  };
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', stage = 'uploading', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);
  await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelectorAll("#result-segments li").length === 1, { timeout: 20_000 });
  return id;
}

const translations = async (parentId: string): Promise<number> => Number((await owner.query(`SELECT count(*)::int AS n FROM "Job" WHERE kind = 'TRANSLATE' AND "parentJobId" = $1`, [parentId])).rows[0].n);

async function say(page: Page, message: string, cards: number): Promise<void> {
  await page.type("#assistant-input", message);
  await press(page, "#assistant-send");
  await waitCount(page, ".assistant__action", cards);
}

describe.skipIf(browserPath === undefined)("acciones del asistente en un navegador real", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-actions-"));
    ai = createServer((request, response) => {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
        const last = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        proposals.push(last);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: fakeAi(last) }] }));
      });
    });
    await new Promise<void>((done) => ai.listen(0, "127.0.0.1", done));
    aiPort = (ai.address() as net.AddressInfo).port;

    const tenant = await createTestTenant("assistant-actions");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = await createApp(
      {
        ...baseConfig,
        reaper: { ...baseConfig.reaper, intervalMs: 0 },
        security: { ...baseConfig.security, webApiKey: tenant.apiKey, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
      },
      { logger: ["error"] },
    );
    await app.listen(port, "127.0.0.1");
    storage = app.get(StorageService);
    owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await owner.connect();
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  }, 90_000);

  afterAll(async () => {
    await closeBrowser(browser);
    await app?.close();
    await owner?.end();
    await new Promise<void>((done) => (ai ? ai.close(() => done()) : done()));
    await disposeTestTenants();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it("una propuesta no hace nada hasta «Aplicar»; al aplicarla acciona el botón real, y «Descartar» la anula", async () => {
    const problems: string[] = [];
    const page = await open(problems);
    const jobId = `acciones-${randomUUID().slice(0, 8)}.mp4`;
    const id = await transcribed(page, jobId);
    await configure(page);

    await say(page, "traduce esto al inglés", 1);
    expect(await text(page, ".assistant__action")).toContain("Traducir a");
    expect(await text(page, ".assistant__action")).toContain("Argos");
    expect(await translations(id)).toBe(0); // solo se propuso: el servidor no ejecutó nada

    await press(page, ".assistant__action .btn--primary");
    await waitText(page, ".assistant__action", "Hecho");
    await page.waitForFunction(async (parent: string) => true, {}, id);
    for (let i = 0; i < 40 && (await translations(id)) === 0; i += 1) await new Promise((done) => setTimeout(done, 250));
    expect(await translations(id)).toBe(1); // al aplicar, la página pulsó «Traducir»

    // Descartar: otra propuesta que se anula no crea nada.
    await say(page, "traduce otra vez", 2);
    await page.$$eval(".assistant__action .btn--ghost", (buttons) => (buttons.at(-1) as unknown as { click(): void }).click());
    await waitText(page, ".assistant__log", "Descartada");
    await new Promise((done) => setTimeout(done, 800));
    expect(await translations(id)).toBe(1);
    expect(problems).toEqual([]);
  }, 180_000);

  it("«Ir al paso» lleva el foco al formulario; una IA que inventa herramientas o argumentos no muestra ninguna tarjeta", async () => {
    const problems: string[] = [];
    const page = await open(problems);
    await transcribed(page, `acciones-${randomUUID().slice(0, 8)}.mp4`);
    await configure(page);

    await say(page, "quiero doblar", 1);
    expect(await text(page, ".assistant__action")).toContain("Ir al paso");
    await press(page, ".assistant__action .btn--primary");
    await waitText(page, ".assistant__action", "Hecho");
    expect(await page.evaluate(() => (globalThis as unknown as Dom).document.activeElement?.closest("#dub-form") !== null)).toBe(true);

    await page.type("#assistant-input", "algo malo");
    await press(page, "#assistant-send");
    await waitText(page, ".assistant__log", "Hecho\\.");
    expect(await count(page, ".assistant__action")).toBe(1); // solo la tarjeta anterior: lo inventado se descartó
    expect(problems).toEqual([]);
  }, 180_000);

  it("con un audio, «quemar» se explica y no se aplica", async () => {
    const problems: string[] = [];
    const page = await open(problems);
    await transcribed(page, `acciones-${randomUUID().slice(0, 8)}.mp3`);
    await configure(page);

    await say(page, "quema los subtítulos", 1);
    await press(page, ".assistant__action .btn--primary");
    await waitText(page, ".assistant__action", "no tiene imagen");
    expect(problems).toEqual([]);
  }, 180_000);
});
