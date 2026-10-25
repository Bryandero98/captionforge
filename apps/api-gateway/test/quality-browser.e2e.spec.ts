// Panel «Calidad» (T5, ADR 0021) en un navegador real, con clics sobre el DOM contra el API de verdad (PostgreSQL, Redis, S3).
// No hay worker: la prueba hace de worker escribiendo el resultado en la base y en S3. Cubre: la norma por idioma, revisar, proponer,
// aplicar el arreglo (el texto solo cambia en saltos de línea) y la revisión posterior sin problemas. Se omite si no hay Chrome o Edge.
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

describe.skipIf(browserPath === undefined)("panel de calidad en un navegador real", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-quality-"));
    const tenant = await createTestTenant("quality-ui");
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

  it("revisa, propone y aplica el arreglo con clics reales; el texto solo cambia en saltos de línea y los tiempos por palabra se conservan", async () => {
    const problems: string[] = [];
    const failures: string[] = [];
    const page = await open(problems, failures);
    const id = await transcribed(page, `calidad-${randomUUID().slice(0, 8)}.mp4`);

    // El panel aparece con las normas del servidor y elige la del idioma del video (español).
    await waitFor(page, "#quality-panel", "visible");
    await page.waitForFunction(() => ((globalThis as unknown as Dom).document.querySelectorAll("#quality-profile option").length ?? 0) === 5, { timeout: 20_000 });
    expect(await prop<string>(page, "#quality-profile", "value")).toBe("netflix-es");
    expect(await text(page, "#quality-profile-note")).toContain("guía oficial");
    expect(await prop<boolean>(page, "#quality-fix", "hidden")).toBe(true);

    // Revisar: dice la gravedad con palabras y el subtítulo afectado.
    await press(page, "#quality-check");
    await waitText(page, "#quality-summary", "Nota");
    const issues = await page.$$eval("#quality-issues li", (items) => items.map((item) => item.textContent ?? ""));
    expect(issues.some((item) => /Error/.test(item) && /línea 2|línea 1/.test(item) && /Subtítulo 1/.test(item))).toBe(true);
    expect(issues.some((item) => /Aviso/.test(item) && /Subtítulo 2/.test(item) && /separación/.test(item))).toBe(true);
    await waitFor(page, "#quality-fix", "visible");

    // Proponer no guarda nada: el almacenamiento sigue igual.
    const before = await readSegments(id);
    await press(page, "#quality-fix");
    await waitFor(page, "#quality-proposal", "visible");
    expect(await text(page, "#quality-proposal-summary")).toMatch(/Subtítulos que cambian: 1/);
    expect(await readSegments(id)).toBe(before);

    // Descartar y volver a proponer.
    await press(page, "#quality-discard");
    await waitFor(page, "#quality-proposal", "hidden");
    await press(page, "#quality-fix");
    await waitFor(page, "#quality-proposal", "visible");

    // Aplicar: se guarda con el flujo de edición, se recarga el editor y la revisión posterior sale limpia.
    await press(page, "#quality-apply");
    await waitFor(page, "#quality-proposal", "hidden");
    await waitText(page, "#quality-summary", "Sin problemas");
    expect(await prop<boolean>(page, "#quality-fix", "hidden")).toBe(true);

    const stored = JSON.parse(await readSegments(id)) as { text: string; words: unknown; end: number }[];
    expect(stored[0]!.text).toContain("\n");
    expect(stored[0]!.text.replace(/\n/g, " ").trim()).toBe(LONG.trim());
    expect(stored[0]!.words).toEqual(SEGMENTS[0]!.words); // solo saltos de línea y tiempos: las palabras se conservan
    expect(stored[1]!.text.trim()).toBe("Fin");
    expect(stored[0]!.end).toBeLessThan(6);

    expect(failures).toEqual([]);
    expect(problems).toEqual([]);
  }, 120_000);

  it("con cambios sin guardar en el editor no deja revisar", async () => {
    const problems: string[] = [];
    const page = await open(problems, []);
    await transcribed(page, `calidad-${randomUUID().slice(0, 8)}.mp4`);
    await waitFor(page, "#quality-panel", "visible");
    await page.waitForFunction(() => ((globalThis as unknown as Dom).document.querySelectorAll("#quality-profile option").length ?? 0) > 0, { timeout: 20_000 });
    expect(await prop<boolean>(page, "#quality-check", "disabled")).toBe(false);
    // Editar un subtítulo en el editor deja cambios sin guardar.
    await page.$eval("#result-segments textarea.seg__text", (area) => {
      const field = area as unknown as { value: string; dispatchEvent(event: unknown): void };
      field.value = `${field.value} extra`;
      field.dispatchEvent(new (globalThis as unknown as { Event: new (type: string, init: object) => unknown }).Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelector("#quality-check")?.disabled === true, { timeout: 20_000 });
    expect(await text(page, "#quality-hint")).toContain("Guarda o descarta");
    expect(problems).toEqual([]);
  }, 120_000);
});
