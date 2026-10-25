// Diseño en celular: la página no debe ensancharse más que la pantalla (cabecera, idiomas y barra de cuenta).
// Se omite si no hay Chrome o Edge.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const baseConfig = loadConfig();
const LONG = " Esta es una frase bastante larga que no cabe en una sola línea de subtítulo";
const SEGMENTS = [
  { start: 0, end: 6, text: LONG, words: [{ start: 0, end: 1, text: " Esta", probability: 0.9 }] },
  { start: 6.02, end: 8, text: " Fin", words: null },
];

let app: Awaited<ReturnType<typeof createApp>>;
let base = "";
let browser: Browser;
let owner: pg.Client;
let storage: StorageService;
let dir = "";
let apiKey = "";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

type Dom = { document: { querySelector(s: string): { hidden: boolean; textContent: string | null; disabled?: boolean; value?: string } | null; querySelectorAll(s: string): { length: number } } };
const press = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { click(): void }).click());
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

async function open(problems: string[], failures: string[]): Promise<Page> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("captionforge_lang", "es");
      localStorage.setItem("cf-tour", "1"); // la guía interactiva no debe tapar los controles de la prueba
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

const readSegments = async (id: string): Promise<string> => {
  const stored = await storage.getBuffer(`jobs/${id}/out/segments.json`, 1 << 20);
  return stored === null ? "" : stored.body.toString("utf8");
};

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
    durationSeconds: 8,
    segmentCount: SEGMENTS.length,
    artifacts: { srt: `jobs/${id}/out/output.srt`, segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag }, waveform: `jobs/${id}/out/waveform.json` },
  };
  await owner.query(`UPDATE "Job" SET status = 'COMPLETED', stage = 'uploading', percent = 100, result = $2::jsonb, "finishedAt" = now(), "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(result)]);
  await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelectorAll("#result-segments li").length === 2, { timeout: 20_000 });
  return id;
}

describe.skipIf(browserPath === undefined)("diseño en celular (360 px)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-mobile-"));
    const tenant = await createTestTenant("mobile-ui");
    apiKey = tenant.apiKey;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = await createApp(
      {
        ...baseConfig,
        reaper: { ...baseConfig.reaper, intervalMs: 0 },
        security: { ...baseConfig.security, webApiKey: apiKey, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 },
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
    await disposeTestTenants();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  type Box = { right: number; left: number };
  type Doc = { documentElement: { scrollWidth: number; clientWidth: number }; querySelector(s: string): { getBoundingClientRect(): Box } | null };
  const overflow = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as { document: Doc }).document.documentElement.scrollWidth - (globalThis as unknown as { document: Doc }).document.documentElement.clientWidth);
  const rightEdge = (page: Page, selector: string): Promise<number> =>
    page.evaluate((sel) => (globalThis as unknown as { document: Doc }).document.querySelector(sel)?.getBoundingClientRect().right ?? -1, selector);

  it("la página no se ensancha más que la pantalla y el selector de idiomas cabe, en 360 y en 320 px", async () => {
    for (const width of [360, 320]) {
      const problems: string[] = [];
      const page = await open(problems, []);
      await page.setViewport({ width, height: 740, isMobile: true, deviceScaleFactor: 2 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".lang");
      expect(await overflow(page), `desborde horizontal a ${width} px`).toBeLessThanOrEqual(0);
      expect(await rightEdge(page, ".lang"), `selector de idiomas a ${width} px`).toBeLessThanOrEqual(width);
      expect(problems).toEqual([]);
      await page.close();
    }
  }, 120_000);

  it("la barra de cuenta con todos sus botones también cabe", async () => {
    const page = await open([], []);
    await page.setViewport({ width: 360, height: 740, isMobile: true, deviceScaleFactor: 2 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".lang");
    await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean; textContent: string } | null } }).document;
      const bar = doc.getElementById("account-bar");
      if (bar) bar.hidden = false;
      for (const id of ["account-team-toggle", "account-keys-toggle", "account-extkeys-toggle"]) {
        const button = doc.getElementById(id);
        if (button) button.hidden = false;
      }
      const name = doc.getElementById("account-name");
      if (name) name.textContent = "Sesión de Bryan Delgado con un nombre bastante largo";
      const role = doc.getElementById("account-role");
      if (role) role.textContent = "Dueño";
    });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const id of ["account-team-toggle", "account-keys-toggle", "account-extkeys-toggle", "account-signout"]) {
      expect(await rightEdge(page, `#${id}`), id).toBeLessThanOrEqual(360);
    }
  }, 120_000);
});
