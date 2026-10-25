// Editor guiado por problemas (ADR 0027) en un navegador real contra el API de verdad (PostgreSQL, Redis, S3).
// No hay worker: la prueba hace de worker escribiendo el resultado en la base y en S3. Cubre: insignia y fichas, marcas por fila y minimapa,
// arreglo de 1 clic (borrador sin guardar), nueva medición, deshacer, teclado y guardar con etag. Se omite si no hay Chrome o Edge.
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

describe.skipIf(browserPath === undefined)("editor guiado en un navegador real", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-guided-"));
    const tenant = await createTestTenant("guided-ui");
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

  const flagsOf = (page: Page, index: number): Promise<string[]> =>
    page.$$eval(
      "#result-segments li",
      (rows, i) => Array.from((rows[i as number] as unknown as { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> }).querySelectorAll(".seg__flag")).map((flag) => flag.textContent ?? ""),
      index,
    );
  const areaValue = (page: Page, index: number): Promise<string> =>
    page.$$eval("#result-segments textarea.seg__text", (areas, i) => (areas[i as number] as unknown as { value: string }).value, index);
  const marksText = (page: Page): Promise<string> => page.$eval("#result-segments li .seg__marks", (element) => element.textContent ?? "");

  it("muestra insignia, fichas, marcas y minimapa; arregla con 1 clic sin guardar, re-mide, deshace y guarda con el teclado", async () => {
    const problems: string[] = [];
    const failures: string[] = [];
    const page = await open(problems, failures);
    const id = await transcribed(page, `guiado-${randomUUID().slice(0, 8)}.mp4`);

    // Insignia con la nota y fichas por regla; la norma del idioma del video es la española.
    await waitFor(page, "#guided", "visible");
    await waitText(page, "#guided-status", "Calidad \\d+ % · \\d+ avisos");
    expect(await prop<string>(page, "#guided-profile", "value")).toBe("netflix-es");
    const chips = await page.$$eval("#guided-chips li", (items) => items.map((item) => item.textContent ?? ""));
    expect(chips.some((chip) => /línea/.test(chip))).toBe(true);

    // Marcas en la fila afectada: icono + palabra de gravedad + frase de la regla.
    const flags = await flagsOf(page, 0);
    expect(flags.some((flag) => /(Error|Aviso)/.test(flag) && /línea/.test(flag))).toBe(true);

    // Minimapa: una lista de botones; pulsar uno lleva el foco al texto del subtítulo.
    expect(await page.$$eval("#guided-map li button", (buttons) => buttons.length)).toBeGreaterThan(0);
    await press(page, "#guided-map li button");
    expect(await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { className: string } } }).document.activeElement.className)).toContain("seg__text");

    // Arreglo de 1 clic: es un borrador (nada se guarda) y el problema desaparece tras volver a medir.
    const before = await readSegments(id);
    await press(page, "#result-segments li .seg__fix");
    await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelector("#guided-undo")?.disabled === false, { timeout: 20_000 });
    expect(await areaValue(page, 0)).toContain("\n");
    expect(await readSegments(id)).toBe(before);
    await page.waitForFunction(() => !/línea/.test((globalThis as unknown as Dom).document.querySelector("#result-segments li .seg__marks")?.textContent ?? ""), { timeout: 20_000 });

    // Deshacer devuelve el texto original y el problema reaparece tras la nueva medición.
    await press(page, "#guided-undo");
    expect(await areaValue(page, 0)).toBe(LONG);
    await page.waitForFunction(() => /línea/.test((globalThis as unknown as Dom).document.querySelector("#result-segments li .seg__marks")?.textContent ?? ""), { timeout: 20_000 });
    expect(await prop<boolean>(page, "#guided-undo", "disabled")).toBe(true);
    expect(await marksText(page)).toMatch(/línea/);

    // Con el teclado: foco en «Arreglar», Enter, y guardar con el etag.
    await page.waitForSelector("#result-segments li .seg__fix");
    await page.focus("#result-segments li .seg__fix");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelector("#editor-save")?.disabled === false, { timeout: 20_000 });
    await press(page, "#editor-save");
    await waitText(page, "#editor-state", "guardad");
    const stored = JSON.parse(await readSegments(id)) as { text: string }[];
    expect(stored[0]!.text).toContain("\n");
    expect(stored[0]!.text.replace(/\n/g, " ").trim()).toBe(LONG.trim());

    expect(failures).toEqual([]);
    expect(problems).toEqual([]);
  }, 180_000);

  it("un tiempo inválido pausa la medición y «Ignorar» oculta el aviso solo en la sesión", async () => {
    const problems: string[] = [];
    const page = await open(problems, []);
    await transcribed(page, `guiado-${randomUUID().slice(0, 8)}.mp4`);
    await waitText(page, "#guided-status", "Calidad \\d+ %");

    // Un inicio mayor que el final: el servidor lo rechazaría, así que no se mide y se explica por qué.
    await page.$$eval("#result-segments li input.seg__t", (inputs) => {
      const field = inputs[0] as unknown as { value: string; dispatchEvent(event: unknown): void };
      field.value = "0:00:09.000";
      field.dispatchEvent(new (globalThis as unknown as { Event: new (type: string, init: object) => unknown }).Event("change", { bubbles: true }));
    });
    await waitText(page, "#guided-status", "Corrige el tiempo");
    await press(page, "#editor-discard");
    await waitText(page, "#guided-status", "Calidad \\d+ %");

    // Ignorar un aviso lo oculta y ofrece mostrarlo de nuevo.
    const total = (await flagsOf(page, 0)).length;
    expect(total).toBeGreaterThan(0);
    await press(page, "#result-segments li .seg__flag button");
    await waitFor(page, "#guided-unignore", "visible");
    expect((await flagsOf(page, 0)).length).toBe(total - 1);
    await press(page, "#guided-unignore");
    await waitFor(page, "#guided-unignore", "hidden");
    expect((await flagsOf(page, 0)).length).toBe(total);
    expect(problems).toEqual([]);
  }, 180_000);
});
