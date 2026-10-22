// La interfaz web (apps/web) en un navegador real contra el API completo: PostgreSQL, Redis y S3 reales.
// Cubre lo que las pruebas unitarias del cliente no pueden: que la CSP deje funcionar la página, que la barra reaccione
// al progreso real de XMLHttpRequest, que «Cancelar» corte la subida de verdad y qué ve el navegador cuando el API
// rechaza una subida antes de leer el cuerpo (cierra la conexión).
//
// Necesita Chrome, Chromium o Edge: se busca en CHROME_PATH y en las rutas habituales; sin navegador, se omite.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

// Las funciones de waitForFunction se ejecutan dentro del navegador; solo se declara lo que usan (sin cargar la librería DOM).
declare const localStorage: { setItem(key: string, value: string): void };
declare const document: {
  querySelector(selector: string): { getAttribute(name: string): string | null; textContent: string | null } | null;
  activeElement: { id: string } | null;
};

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
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const token = `e2e-web-${randomUUID().slice(0, 8)}`;
let dir = "";
let browser: Browser;
let prisma: PrismaService;

type Overrides = { maxUploadBytes?: number; uploadRateLimitPerMinute?: number; eventStreamMaxMs?: number };

async function startApi(overrides: Overrides = {}): Promise<string> {
  const app = await createApp(
    {
      ...baseConfig,
      maxUploadBytes: overrides.maxUploadBytes ?? baseConfig.maxUploadBytes,
      reaper: { ...baseConfig.reaper, intervalMs: 0 },
      security: {
        apiKey: undefined,
        rateLimitPerMinute: 0,
        uploadRateLimitPerMinute: overrides.uploadRateLimitPerMinute ?? 0,
        trustProxy: false,
        maxConcurrentUploads: 0,
        maxConcurrentUploadsPerClient: 0,
        uploadMinBytesPerSecond: 0,
        uploadRateWindowMs: 30_000,
        maxEventStreams: 0,
        maxEventStreamsPerClient: 0,
        eventStreamMaxMs: overrides.eventStreamMaxMs ?? 0,
        allowedOrigins: [],
        allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      },
    },
    { logger: ["error"] },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  prisma = app.get(PrismaService);
  return `http://127.0.0.1:${new URL(await app.getUrl()).port}`;
}

/** Un archivo de bytes aleatorios con extensión de video: el navegador le pone el tipo por la extensión. */
function videoFile(name: string, bytes: number): string {
  const path = join(dir, `${token}-${name}`);
  writeFileSync(path, randomBytes(bytes));
  return path;
}

type Spy = { problems: string[] };

/** Página nueva con vigilancia de errores de consola, excepciones, violaciones de CSP y peticiones fallidas. */
async function openPage(base: string, throttleBytesPerSecond?: number): Promise<{ page: Page; spy: Spy }> {
  const page = await browser.newPage();
  const spy: Spy = { problems: [] };
  page.on("console", (message) => {
    if (message.type() === "error") spy.problems.push(`consola: ${message.text()}`);
  });
  page.on("pageerror", (error) => spy.problems.push(`excepción: ${String(error)}`));
  page.on("requestfailed", (request) => {
    // Cancelar aborta a propósito la subida: eso no es un fallo.
    if (request.failure()?.errorText !== "net::ERR_ABORTED") spy.problems.push(`petición fallida: ${request.url()} ${request.failure()?.errorText}`);
  });
  // El idioma sale del navegador (en CI es inglés): las pruebas fijan español con la preferencia guardada.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("captionforge_lang", "es");
    } catch {
      // sin almacenamiento: queda el idioma del navegador
    }
  });
  if (throttleBytesPerSecond !== undefined) {
    const session = await page.createCDPSession();
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: throttleBytesPerSecond });
  }
  await page.goto(base, { waitUntil: "networkidle0" });
  return { page, spy };
}

const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
const isVisible = (page: Page, selector: string) => page.$eval(selector, (element) => !(element as unknown as { hidden: boolean }).hidden);
const progress = (page: Page) => page.$eval("#bar", (element) => Number(element.getAttribute("aria-valuenow") ?? "-1"));

async function chooseFile(page: Page, path: string): Promise<void> {
  const input = await page.$("#file-input");
  await input!.uploadFile(path);
}

async function jobsNamed(name: string): Promise<{ id: string; status: string }[]> {
  return prisma.job.findMany({ where: { originalFilename: { contains: name } }, select: { id: true, status: true } });
}

describe.skipIf(browserPath === undefined)("la interfaz web en un navegador real", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-web-e2e-"));
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (prisma !== undefined) await prisma.job.deleteMany({ where: { originalFilename: { contains: token } } }).catch(() => undefined);
    for (const app of apps) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("carga con la CSP puesta, sin errores, con los idiomas y el cambio ES/EN", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    expect(await page.title()).toBe("CaptionForge");
    expect(await page.$$eval("#opt-source option", (options) => options.length)).toBeGreaterThan(90);
    expect(await page.$$eval("#opt-model option", (options) => options.length)).toBe(3);
    expect(await page.$eval("#start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(await text(page, "#drop-formats")).toContain("4 GB");

    await page.click("#lang-en");
    expect(await text(page, "#start")).toBe("Generate captions");
    expect(await page.$eval("html", (html) => html.lang)).toBe("en");
    await page.click("#lang-es");
    expect(await text(page, "#start")).toBe("Generar subtítulos");

    expect(spy.problems).toEqual([]);
    await page.close();
  });

  it("un formato que el API rechazaría se avisa antes de subir y no deja generar", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    await chooseFile(page, videoFile("notas.txt", 64));
    await page.waitForSelector("#file-problem:not([hidden])");
    expect(await text(page, "#file-problem")).toContain("Formato no admitido");
    expect(await page.$eval("#start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(spy.problems).toEqual([]);
    await page.close();
  });

  it("la barra avanza con el progreso real de la subida y termina en «en cola» con el trabajo creado", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base, 400 * 1024);
    const name = "progreso.mp4";
    await chooseFile(page, videoFile(name, 2 * 1024 * 1024));
    await page.click("#start");

    await page.waitForSelector("#progress-panel:not([hidden])");
    await page.waitForFunction(() => Number(document.querySelector("#bar")?.getAttribute("aria-valuenow")) >= 10, { timeout: 20_000 });
    const first = await progress(page);
    await page.waitForFunction((from) => Number(document.querySelector("#bar")?.getAttribute("aria-valuenow")) > from, { timeout: 20_000 }, first);
    expect(await progress(page)).toBeGreaterThan(first);
    expect(await text(page, "#progress-status")).toMatch(/Subiendo|Guardando/);
    expect(await page.$eval("#cancel", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(false);

    await page.waitForSelector("#notice-panel:not([hidden])", { timeout: 40_000 });
    expect(await text(page, "#notice-text")).toContain("en cola");
    expect(await text(page, "#notice-job")).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(await isVisible(page, "#progress-panel")).toBe(false);
    expect(await jobsNamed(name)).toHaveLength(1);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("«Cancelar» corta la subida de verdad: la interfaz lo dice sin error y el API no crea ningún trabajo", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base, 200 * 1024);
    const name = "cancelada.mp4";
    await chooseFile(page, videoFile(name, 4 * 1024 * 1024));
    await page.click("#start");
    await page.waitForFunction(() => Number(document.querySelector("#bar")?.getAttribute("aria-valuenow")) >= 5, { timeout: 20_000 });

    await page.click("#cancel");
    await page.waitForSelector("#notice-panel:not([hidden])", { timeout: 10_000 });
    expect(await text(page, "#notice-text")).toContain("cancelada");
    expect(await isVisible(page, "#error-panel")).toBe(false);
    expect(await isVisible(page, "#progress-panel")).toBe(false);
    expect(await isVisible(page, "#notice-retry")).toBe(true); // se puede volver a intentar con el mismo archivo

    // El servidor ve el corte de la conexión y descarta lo recibido: se espera a que pase, sin pausas fijas.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await jobsNamed(name)).toHaveLength(0);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("un archivo que supera el máximo del servidor: la interfaz muestra un error con salida, no se queda colgada", async () => {
    // El cliente cree que el máximo es 4 GiB (meta); el API admite 1 MiB: el rechazo llega del servidor.
    const base = await startApi({ maxUploadBytes: 1024 * 1024 });
    const { page } = await openPage(base);
    await chooseFile(page, videoFile("grande.mp4", 3 * 1024 * 1024));
    await page.click("#start");
    await page.waitForSelector("#error-panel:not([hidden])", { timeout: 30_000 });
    const message = await text(page, "#error-message");
    // El API descarta lo que falta del cuerpo (early-reject.e2e.spec.ts): el navegador recibe el 413 de verdad, no un corte.
    expect(message).toContain("tamaño máximo");
    expect(await isVisible(page, "#error-retry")).toBe(false); // reintentar el mismo archivo no serviría de nada
    expect(await isVisible(page, "#error-other")).toBe(true);
    await page.close();
  }, 60_000);

  /** Hace de worker: escribe el estado del trabajo en PostgreSQL y el SSE real del API lo reenvía al navegador. */
  async function workerSays(name: string, data: { status?: "RUNNING" | "COMPLETED" | "FAILED"; stage?: string; percent?: number; message?: string; errorCode?: string; errorMessage?: string }) {
    const [job] = await jobsNamed(name);
    await prisma.job.update({ where: { id: job!.id }, data: { ...data, ...(data.status === "COMPLETED" || data.status === "FAILED" ? { finishedAt: new Date() } : {}) } });
  }

  const jobText = (page: Page) => text(page, "#job-status");
  const waitForJobText = (page: Page, expected: string) =>
    page.waitForFunction((value) => (document.querySelector("#job-status")?.textContent ?? "").includes(value), { timeout: 15_000 }, expected);

  async function uploadAndFollow(page: Page, name: string): Promise<void> {
    await chooseFile(page, videoFile(name, 20 * 1024));
    await page.click("#start");
    await page.waitForSelector("#job-panel:not([hidden])", { timeout: 20_000 });
  }

  it("seguimiento: la etapa y el porcentaje del worker llegan por SSE a la interfaz y el flujo se cierra al completarse", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const eventRequests: string[] = [];
    page.on("request", (request) => request.url().endsWith("/events") && eventRequests.push(request.url()));
    const name = "sigue.mp4";
    await uploadAndFollow(page, name);
    await waitForJobText(page, "En cola");
    expect(await isVisible(page, "#job-bar")).toBe(true);

    await workerSays(name, { status: "RUNNING", stage: "extracting_audio", percent: 10 });
    await waitForJobText(page, "Extrayendo el audio · 10 %");
    await workerSays(name, { stage: "transcribing", percent: 55 });
    await waitForJobText(page, "Transcribiendo · 55 %");
    expect(await page.$eval("#job-bar", (bar) => bar.getAttribute("aria-valuenow"))).toBe("55");

    await workerSays(name, { status: "COMPLETED", stage: "uploading", percent: 100 });
    await waitForJobText(page, "Listo");
    expect(await page.$eval("#job-bar", (bar) => bar.getAttribute("aria-valuenow"))).toBe("100");
    // El anuncio se repone tras una pausa breve (para que un texto repetido se vuelva a leer).
    await page.waitForFunction(() => (document.querySelector("#announcer")?.textContent ?? "").includes("Listo"), { timeout: 5000 });

    // Estado final: no se vuelve a abrir el flujo.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(eventRequests).toHaveLength(1);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("seguimiento: un trabajo que falla muestra su causa en el idioma de la interfaz y se puede empezar de nuevo", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const name = "falla.mp4";
    await uploadAndFollow(page, name);
    await workerSays(name, { status: "FAILED", errorCode: "FFMPEG_FAILED", errorMessage: "ffmpeg salió con código 1" });
    await waitForJobText(page, "No se pudo leer el audio");
    expect(await page.$eval("#job-panel", (panel) => panel.classList.contains("is-failed"))).toBe(true);
    expect(await isVisible(page, "#job-bar")).toBe(false);
    expect(await text(page, "#job-detail")).toContain("ffmpeg salió con código 1");

    await page.click("#lang-en");
    expect(await jobText(page)).toContain("could not be read");
    await page.click("#notice-again");
    expect(await isVisible(page, "#job-panel")).toBe(false);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("seguimiento: si el servidor corta el flujo (tope de duración) la interfaz reconecta sola y sigue recibiendo", async () => {
    const base = await startApi({ eventStreamMaxMs: 1200 });
    const { page, spy } = await openPage(base);
    const eventRequests: string[] = [];
    page.on("request", (request) => request.url().endsWith("/events") && eventRequests.push(request.url()));
    const name = "reconecta.mp4";
    await uploadAndFollow(page, name);
    await workerSays(name, { status: "RUNNING", stage: "transcribing", percent: 20 });
    await waitForJobText(page, "Transcribiendo · 20 %");

    await page.waitForFunction(() => true); // deja correr al menos dos cortes del servidor
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(eventRequests.length).toBeGreaterThanOrEqual(2);
    await workerSays(name, { stage: "transcribing", percent: 80 });
    await waitForJobText(page, "Transcribiendo · 80 %");
    expect(await text(page, "#job-detail")).toBe("");
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("429: el reintento queda en cuenta atrás con los segundos que pide el servidor", async () => {
    const base = await startApi({ uploadRateLimitPerMinute: 1 });
    const { page } = await openPage(base);
    await chooseFile(page, videoFile("uno.mp4", 20 * 1024));
    await page.click("#start");
    await page.waitForSelector("#notice-panel:not([hidden])", { timeout: 20_000 });
    await page.click("#notice-again");

    await chooseFile(page, videoFile("dos.mp4", 20 * 1024));
    await page.click("#start");
    await page.waitForSelector("#error-panel:not([hidden])", { timeout: 20_000 });
    // El servidor descarta el cuerpo restante (early-reject.e2e.spec.ts): el navegador ve el 429 de verdad.
    expect(await text(page, "#error-message")).toMatch(/Reintenta en \d+ s/);
    expect(await page.$eval("#error-retry", (button) => button.getAttribute("aria-disabled"))).toBe("true");
    expect(await text(page, "#error-retry")).toMatch(/^Reintentar \(\d+ s\)$/);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("error-retry"); // conserva el foco durante la espera

    // Cambiar de idioma no reinicia la cuenta atrás.
    const before = Number(/\d+/.exec(await text(page, "#error-retry"))?.[0]);
    await page.click("#lang-en");
    expect(await text(page, "#error-retry")).toMatch(/^Try again \(\d+ s\)$/);
    expect(Number(/\d+/.exec(await text(page, "#error-retry"))?.[0])).toBeLessThanOrEqual(before);
    await page.close();
  }, 60_000);
});
