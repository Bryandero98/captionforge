// La interfaz web (apps/web) en un navegador real contra el API completo: PostgreSQL, Redis y S3 reales.
// Cubre lo que las pruebas unitarias del cliente no pueden: que la CSP deje funcionar la página, que la barra reaccione
// al progreso real de XMLHttpRequest, que «Cancelar» corte la subida de verdad y qué ve el navegador cuando el API
// rechaza una subida antes de leer el cuerpo (cierra la conexión).
//
// Necesita Chrome, Chromium o Edge: se busca en CHROME_PATH y en las rutas habituales; sin navegador, se omite.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { StorageService } from "../src/storage/storage.service.js";

// Las funciones de waitForFunction se ejecutan dentro del navegador; solo se declara lo que usan (sin cargar la librería DOM).
declare const localStorage: { setItem(key: string, value: string): void; getItem(key: string): string | null };
declare const document: {
  querySelector(selector: string): { getAttribute(name: string): string | null; textContent: string | null } | null;
  activeElement: { id: string } | null;
  querySelectorAll(selector: string): { length: number };
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
let storage: StorageService;

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
  storage = app.get(StorageService);
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

async function chooseFiles(page: Page, paths: string[]): Promise<void> {
  const input = await page.$("#file-input");
  await input!.uploadFile(...paths);
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
    const [job] = await jobsNamed(`${token}-${name}`);
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

    await workerCompletes(name, SEGMENTS);
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

  const NL = String.fromCharCode(10);

  /** Hace de worker al terminar: sube los subtítulos a S3 y deja el trabajo COMPLETED con su resultado. */
  async function workerCompletes(name: string, segments: { start: number; end: number; text: string; words: null }[], extra: Record<string, unknown> = {}) {
    const [job] = await jobsNamed(`${token}-${name}`);
    const id = job!.id;
    const segmentsKey = `jobs/${id}/out/segments.json`;
    const srtKey = `jobs/${id}/out/output.srt`;
    const { etag } = await storage.putBuffer(segmentsKey, Buffer.from(JSON.stringify(segments)), "application/json");
    await storage.putBuffer(srtKey, Buffer.from("1" + NL + "00:00:00,000 --> 00:00:02,000" + NL + "Hola" + NL), "application/x-subrip");
    const result = {
      schemaVersion: 1,
      jobId: id,
      detectedLanguage: "es",
      device: "cpu",
      durationSeconds: 125,
      segmentCount: segments.length,
      ...extra,
      artifacts: { srt: srtKey, segments: { bucket: baseConfig.s3.bucket, objectKey: segmentsKey, etag }, waveform: `jobs/${id}/out/waveform.json` },
    };
    await prisma.job.update({ where: { id }, data: { status: "COMPLETED", stage: "uploading", percent: 100, result, finishedAt: new Date() } });
  }

  const SEGMENTS = [
    { start: 0, end: 2, text: " Hola & bienvenidos <b>todos</b>", words: null },
    { start: 2, end: 4, text: " Segunda frase", words: null },
    { start: 4, end: 6, text: " Tercera", words: null },
  ];

  it("limpieza de audio: la casilla viaja en las opciones, la etapa nueva se ve y el resultado dice «Audio limpiado: Sí»", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const name = "ruidoso.mp4";
    await chooseFile(page, videoFile(name, 20 * 1024));
    expect(await page.$eval("#opt-clean", (box) => (box as unknown as { checked: boolean }).checked)).toBe(false); // desactivada por defecto
    expect(await text(page, 'label[for="opt-clean"]')).toBe("Limpiar ruido de fondo (más lento, para música o ruido fuerte)");
    await page.click("#opt-clean");
    await page.click("#start");
    await page.waitForSelector("#job-panel:not([hidden])", { timeout: 20_000 });
    const [job] = await jobsNamed(`${token}-${name}`);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).options).toMatchObject({ cleanAudio: true });

    await prisma.job.update({ where: { id: job!.id }, data: { status: "RUNNING", stage: "separating_voice", percent: 25, startedAt: new Date(), message: "Limpiando el audio (50%)" } });
    await page.waitForFunction(() => (document.querySelector("#job-status")?.textContent ?? "").includes("Limpiando el ruido de fondo"), { timeout: 15_000 });
    await workerCompletes(name, SEGMENTS, { audioCleaned: true });
    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    expect(await page.$eval("#result-clean-row", (row) => !row.hasAttribute("hidden"))).toBe(true);
    expect(await text(page, "#result-clean")).toBe("Sí");
    expect(await page.$eval("#result-clean-note", (note) => note.hasAttribute("hidden"))).toBe(true);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 90_000);

  it("limpieza de audio: si el worker usó el audio original, se muestra «No» y una alerta informativa", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const name = "respaldo.mp4";
    await chooseFile(page, videoFile(name, 20 * 1024));
    await page.click("#opt-clean");
    await page.click("#start");
    await page.waitForSelector("#job-panel:not([hidden])", { timeout: 20_000 });
    await workerCompletes(name, SEGMENTS, { audioCleaned: false });
    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    expect(await text(page, "#result-clean")).toBe("No");
    expect(await page.$eval("#result-clean-note", (note) => !note.hasAttribute("hidden"))).toBe(true);
    expect(await text(page, "#result-clean-note")).toContain("se transcribió el audio original");
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 90_000);

  it("limpieza de audio: sin pedirla, el resultado no muestra ni indicador ni alerta", async () => {
    const base = await startApi();
    const { page } = await openPage(base);
    const name = "limpio.mp4";
    await uploadAndFollow(page, name);
    const [job] = await jobsNamed(`${token}-${name}`);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).options).toMatchObject({ cleanAudio: false });
    await workerCompletes(name, SEGMENTS, { audioCleaned: false });
    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    expect(await page.$eval("#result-clean-row", (row) => row.hasAttribute("hidden"))).toBe(true);
    expect(await page.$eval("#result-clean-note", (note) => note.hasAttribute("hidden"))).toBe(true);
    await page.close();
  }, 90_000);

  it("resultado: al completarse se muestran los datos, los subtítulos y las descargas (.srt del servidor, .vtt del cliente)", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const downloads = mkdtempSync(join(tmpdir(), "cf-dl-"));
    const session = await browser.target().createCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    const name = "entrevista.mp4";
    await uploadAndFollow(page, name);
    await workerCompletes(name, SEGMENTS);

    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll("#result-segments li").length === 3, { timeout: 15_000 });
    expect(await text(page, "#result-language")).toMatch(/Español/i);
    expect(await text(page, "#result-duration")).toContain("2 min");
    expect(await text(page, "#result-count")).toBe("3");
    // El texto del subtítulo es texto, no HTML: la etiqueta se ve tal cual y no se crea ningún nodo.
    expect(await page.$eval("#result-segments li:first-child .seg__text", (area) => (area as unknown as { value: string }).value)).toContain("<b>todos</b>");
    expect(await page.$$eval("#result-segments b", (nodes) => nodes.length)).toBe(0);

    const srtHref = await page.$eval("#dl-srt", (link) => link.getAttribute("href"));
    expect(srtHref).toMatch(/\/v1\/jobs\/[0-9a-f-]{36}\/artifacts\/srt$/);
    const srt = await page.evaluate(async (href) => {
      const response = await fetch(href as string);
      return { status: response.status, disposition: response.headers.get("content-disposition"), body: await response.text() };
    }, srtHref);
    expect(srt.status).toBe(200);
    expect(srt.disposition).toContain("entrevista.srt");

    await page.click("#dl-vtt");
    // El nombre es el del video subido (con el prefijo único de la prueba) y la extensión .vtt.
    const found = () => readdirSync(downloads).find((entry) => entry.endsWith(".vtt"));
    for (let i = 0; i < 150 && found() === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(found()).toBe(`${token}-entrevista.vtt`);
    const vtt = readFileSync(join(downloads, found()!), "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:02.000 --> 00:00:04.000");
    expect(vtt).toContain("Hola &amp; bienvenidos &lt;b&gt;todos&lt;/b&gt;");
    expect(spy.problems).toEqual([]);
    await session.detach();
    rmSync(downloads, { recursive: true, force: true });
    await page.close();
  }, 60_000);

  const rowValue = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { value: string }).value);

  /** Sube un video, hace de worker y deja abierto el editor con los tres subtítulos de prueba. */
  async function openEditorFor(base: string, name: string) {
    const opened = await openPage(base);
    await uploadAndFollow(opened.page, name);
    await workerCompletes(name, SEGMENTS);
    await opened.page.waitForFunction(() => document.querySelectorAll("#result-segments li").length === 3, { timeout: 15_000 });
    const [job] = await jobsNamed(`${token}-${name}`);
    return { ...opened, jobId: job!.id };
  }

  async function retype(page: Page, selector: string, value: string) {
    await page.click(selector, { count: 3 });
    await page.keyboard.type(value);
  }

  it("editor: cambiar un texto marca el subtítulo, desactiva las descargas y al guardar el servidor lo recibe", async () => {
    const base = await startApi();
    const { page, spy, jobId } = await openEditorFor(base, "edita.mp4");
    expect(await text(page, "#editor-state")).toContain("Sin cambios");
    expect(await page.$eval("#editor-save", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(true);

    await retype(page, "#result-segments li:nth-child(2) .seg__text", "Segunda corregida");
    expect(await text(page, "#editor-state")).toContain("1 subtítulos con cambios sin guardar");
    expect(await page.$eval("#result-segments li:nth-child(2)", (row) => row.classList.contains("is-dirty"))).toBe(true);
    expect(await page.$eval("#dl-vtt", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(await page.$eval("#dl-srt", (link) => link.getAttribute("aria-disabled"))).toBe("true");
    expect(await text(page, "#dl-hint")).toContain("Guarda los cambios");

    await page.click("#editor-save");
    await page.waitForFunction(() => (document.querySelector("#editor-state")?.textContent ?? "").includes("Cambios guardados"), { timeout: 10_000 });
    expect(await page.$eval("#result-segments li:nth-child(2)", (row) => row.classList.contains("is-dirty"))).toBe(false);
    expect(await page.$eval("#dl-vtt", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(false);

    const saved = (await fetch(`${base}/v1/jobs/${jobId}/segments`).then((response) => response.json())) as { segments: { text: string }[] };
    expect(saved.segments[1]!.text).toBe("Segunda corregida");
    const srt = await fetch(`${base}/v1/jobs/${jobId}/artifacts/srt`).then((response) => response.text());
    expect(srt).toContain("Segunda corregida");
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("editor: un tiempo ilegible o un inicio mayor que el fin se marcan y no se envían; descartar vuelve a lo guardado", async () => {
    const base = await startApi();
    const { page, jobId } = await openEditorFor(base, "valida.mp4");

    await retype(page, "#result-segments li:first-child .seg__t:nth-child(1)", "abc");
    await page.keyboard.press("Tab");
    expect(await isVisible(page, "#result-segments li:first-child .seg__issue")).toBe(true);
    expect(await text(page, "#result-segments li:first-child .seg__issue")).toContain("Tiempo no válido");

    await retype(page, "#result-segments li:first-child .seg__t:nth-child(1)", "0:00:03.000");
    await page.keyboard.press("Tab");
    expect(await text(page, "#result-segments li:first-child .seg__issue")).toContain("El inicio debe ser menor que el fin");
    await page.click("#editor-save");
    expect(await text(page, "#editor-state")).toContain("Corrige los subtítulos marcados");
    const untouched = (await fetch(`${base}/v1/jobs/${jobId}/segments`).then((response) => response.json())) as { segments: { start: number }[] };
    expect(untouched.segments[0]!.start).toBe(0); // no llegó nada al servidor

    await page.click("#editor-discard");
    expect(await text(page, "#editor-state")).toContain("Sin cambios");
    expect(await rowValue(page, "#result-segments li:first-child .seg__t:nth-child(1)")).toBe("00:00:00.000");
    expect(await isVisible(page, "#result-segments li:first-child .seg__issue")).toBe(false);
    await page.close();
  }, 60_000);

  it("editor: si los subtítulos cambiaron en otro sitio (409) se ofrece cargar lo nuevo o sobrescribir, sin pisar nada en silencio", async () => {
    const base = await startApi();
    const { page, spy, jobId } = await openEditorFor(base, "conflicto.mp4");

    // «Otra pestaña» edita el subtítulo 3 mientras esta tiene cambios sin guardar en el 1.
    const other = await fetch(`${base}/v1/jobs/${jobId}/segments`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ segments: [{ index: 2, text: "Desde otra pestaña" }] }),
    });
    expect(other.status).toBe(200);

    await retype(page, "#result-segments li:first-child .seg__text", "Mi cambio");
    await page.click("#editor-save");
    await page.waitForSelector("#editor-conflict:not([hidden])", { timeout: 10_000 });
    expect(await text(page, "#editor-state")).toContain("cambiaron desde que los abriste");
    expect(await rowValue(page, "#result-segments li:first-child .seg__text")).toBe("Mi cambio"); // lo escrito sigue ahí
    const mid = (await fetch(`${base}/v1/jobs/${jobId}/segments`).then((response) => response.json())) as { segments: { text: string }[] };
    expect(mid.segments[0]!.text).toBe(" Hola & bienvenidos <b>todos</b>"); // el servidor no recibió nada

    await page.click("#editor-overwrite");
    await page.waitForFunction(() => (document.querySelector("#editor-state")?.textContent ?? "").includes("Cambios guardados"), { timeout: 10_000 });
    const final = (await fetch(`${base}/v1/jobs/${jobId}/segments`).then((response) => response.json())) as { segments: { text: string }[] };
    expect(final.segments[0]!.text).toBe("Mi cambio");
    expect(final.segments[2]!.text).toBe("Desde otra pestaña"); // lo de la otra pestaña se conserva: se editó por índice
    expect(await isVisible(page, "#editor-conflict")).toBe(false);
    expect(spy.problems.filter((problem) => !problem.includes("409"))).toEqual([]);
    await page.close();
  }, 60_000);

  it("editor: Ctrl+S dentro de un campo de tiempo guarda también lo que se acaba de escribir en él", async () => {
    const base = await startApi();
    const { page, jobId } = await openEditorFor(base, "atajo.mp4");
    await retype(page, "#result-segments li:first-child .seg__t:nth-child(1)", "0:00:01.000");
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyS");
    await page.keyboard.up("Control");
    await page.waitForFunction(() => (document.querySelector("#editor-state")?.textContent ?? "").includes("Cambios guardados"), { timeout: 10_000 });
    const saved = (await fetch(`${base}/v1/jobs/${jobId}/segments`).then((response) => response.json())) as { segments: { start: number }[] };
    expect(saved.segments[0]!.start).toBe(1);
    await page.close();
  }, 60_000);

  it("editor: una línea en blanco en el texto se marca antes de enviar y el aviso queda asociado al campo", async () => {
    const base = await startApi();
    const { page } = await openEditorFor(base, "blanco.mp4");
    await retype(page, "#result-segments li:first-child .seg__text", "uno");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("dos");
    expect(await text(page, "#result-segments li:first-child .seg__issue")).toContain("líneas en blanco");
    const wiring = await page.$eval("#result-segments li:first-child .seg__text", (area) => ({ invalid: area.getAttribute("aria-invalid"), described: area.getAttribute("aria-describedby") }));
    expect(wiring.invalid).toBe("true");
    expect(wiring.described).toMatch(/^seg-issue-0$/);
    expect(await page.$eval("#result-segments li:first-child .seg__t:nth-child(1)", (input) => input.getAttribute("aria-invalid"))).toBe("false");
    await page.close();
  }, 60_000);

  async function burnJobOf(parentId: string) {
    return prisma.job.findFirstOrThrow({ where: { parentJobId: parentId } });
  }

  /** El worker termina el quemado: sube un «video» a S3 y deja el trabajo COMPLETED con su resultado. */
  async function workerFinishesBurn(burnId: string) {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: burnId } });
    const key = `${job.outputPrefix}captioned.mp4`;
    await storage.putBuffer(key, Buffer.alloc(4096, 7), "video/mp4");
    const result = { schemaVersion: 1, jobId: burnId, usedKaraoke: false, artifacts: { video: key } };
    await prisma.job.update({ where: { id: burnId }, data: { status: "COMPLETED", stage: "burning", percent: 100, result, finishedAt: new Date() } });
  }

  it("idiomas: sin preferencia guardada usa el del navegador (alemán), avisa de que es traducción automática y la guía se despliega", async () => {
    const base = await startApi();
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, "languages", { get: () => ["de-DE", "en"] });
    });
    await page.goto(base, { waitUntil: "networkidle0" });
    expect(await page.$eval("html", (html) => html.lang)).toBe("de");
    expect(await text(page, "#start")).toBe("Untertitel erstellen");
    expect((await text(page, "#lang-notice")).length).toBeGreaterThan(20);
    expect(await page.$eval("#lang-de", (button) => button.getAttribute("aria-pressed"))).toBe("true");
    await page.click("#guide > summary");
    expect(await page.$$eval("#guide li", (items) => items.filter((item) => (item.textContent ?? "").trim().length > 20).length)).toBe(6);
    // Cambiar a español quita el aviso y se recuerda.
    await page.click("#lang-es");
    expect(await text(page, "#lang-notice")).toBe("");
    expect(await page.evaluate(() => localStorage.getItem("captionforge_lang"))).toBe("es");
    await page.close();
  }, 60_000);

  it("cola: varios videos se suben de uno en uno, cada uno crea su trabajo y los inválidos se descartan con motivo", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const names = ["cola-uno.mp4", "cola-dos.mp4", "cola-tres.mp4"];
    await chooseFiles(page, [...names.map((name) => videoFile(name, 20 * 1024)), videoFile("cola-notas.txt", 64)]);
    expect(await page.$$eval("#batch-list li", (items) => items.length)).toBe(3);
    expect(await text(page, "#file-problem")).toContain("cola-notas.txt");
    expect(await text(page, "#start")).toBe("Generar subtítulos de 3 videos");

    await page.click("#start");
    await page.waitForFunction(() => document.querySelectorAll('#batch-list li[data-status="done"]').length === 3, { timeout: 40_000 });
    await page.waitForSelector("#notice-panel:not([hidden])", { timeout: 10_000 });
    expect(await text(page, "#notice-text")).toContain("Recibidos 3 videos");
    for (const name of names) expect(await jobsNamed(`${token}-${name}`)).toHaveLength(1);
    expect(await page.$$eval("#history-list li", (items) => items.length)).toBe(3);
    // Una subida terminada se puede abrir desde la propia cola.
    await page.click('#batch-list li[data-status="done"] .btn');
    await waitForJobText(page, "En cola");
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 90_000);

  it("cola: si uno falla (429) la cola se detiene ahí, lo ya subido se conserva y los pendientes siguen en la lista", async () => {
    const base = await startApi({ uploadRateLimitPerMinute: 2 });
    const { page } = await openPage(base);
    const names = ["lim-uno.mp4", "lim-dos.mp4", "lim-tres.mp4", "lim-cuatro.mp4"];
    await chooseFiles(page, names.map((name) => videoFile(name, 20 * 1024)));
    await page.click("#start");
    await page.waitForSelector("#error-panel:not([hidden])", { timeout: 40_000 });
    expect(await text(page, "#error-message")).toMatch(/Reintenta en \d+ s/);
    const statuses = await page.$$eval("#batch-list li", (items) => items.map((item) => item.getAttribute("data-status")));
    expect(statuses).toEqual(["done", "done", "error", "pending"]);
    expect(await jobsNamed(`${token}-lim-uno.mp4`)).toHaveLength(1);
    expect(await jobsNamed(`${token}-lim-dos.mp4`)).toHaveLength(1);
    expect(await jobsNamed(`${token}-lim-tres.mp4`)).toHaveLength(0);
    expect(await jobsNamed(`${token}-lim-cuatro.mp4`)).toHaveLength(0); // no se saltó a los siguientes
    // El pendiente se puede quitar de la cola; el fallo sigue siendo lo que toca reintentar.
    await page.click('#batch-list li[data-status="pending"] .btn');
    expect(await page.$$eval("#batch-list li", (items) => items.length)).toBe(3);
    await page.close();
  }, 90_000);

  it("quemado: se crea un trabajo propio, se sigue su progreso y al terminar aparecen el video y su descarga", async () => {
    const base = await startApi();
    const { page, spy, jobId } = await openEditorFor(base, "quema.mp4");
    // Estos subtítulos no traen tiempos por palabra: el karaoke no se puede elegir y se dice por qué.
    expect(await page.$eval("#burn-karaoke", (box) => (box as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(await text(page, "#burn-hint")).toContain("tiempos por palabra");
    await page.select("#burn-style", "tiktok");
    await page.click("#burn-start");

    await page.waitForSelector("#burn-panel:not([hidden])", { timeout: 15_000 });
    await page.waitForFunction(() => (document.querySelector("#burn-status")?.textContent ?? "").includes("En cola"), { timeout: 10_000 });
    const burn = await burnJobOf(jobId);
    expect(burn.kind).toBe("BURN");
    expect(burn.options).toMatchObject({ style: "tiktok" });
    // Mientras hay un quemado en curso no se puede lanzar otro.
    expect(await page.$eval("#burn-start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(await text(page, "#burn-hint")).toContain("Ya hay un video en preparación");

    await prisma.job.update({ where: { id: burn.id }, data: { status: "RUNNING", stage: "burning", percent: 50 } });
    await page.waitForFunction(() => (document.querySelector("#burn-status")?.textContent ?? "").includes("Quemando los subtítulos en el video · 50 %"), { timeout: 10_000 });
    expect(await isVisible(page, "#burn-cancel")).toBe(true);

    await workerFinishesBurn(burn.id);
    await page.waitForFunction(() => (document.querySelector("#burn-status")?.textContent ?? "").includes("Video listo"), { timeout: 10_000 });
    expect(await isVisible(page, "#burn-video")).toBe(true);
    expect(await page.$eval("#burn-video", (video) => video.getAttribute("src"))).toMatch(/\/v1\/jobs\/[0-9a-f-]{36}\/artifacts\/video$/);
    expect(await page.$eval("#burn-download", (link) => link.getAttribute("href"))).toMatch(/\/artifacts\/video$/);
    // El navegador puede pedir rangos del video (saltar sin bajarlo entero).
    const range = await page.evaluate(async (href) => {
      const response = await fetch(href as string, { headers: { Range: "bytes=0-9" } });
      return { status: response.status, length: (await response.arrayBuffer()).byteLength };
    }, await page.$eval("#burn-video", (video) => video.getAttribute("src")));
    expect(range).toEqual({ status: 206, length: 10 });
    expect(await page.$eval("#burn-start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(false);
    expect(await page.$$eval("#history-list li", (items) => items.length)).toBe(2);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 90_000);

  it("quemado: con cambios sin guardar no se puede crear el video (saldría con los subtítulos viejos)", async () => {
    const base = await startApi();
    const { page } = await openEditorFor(base, "sucio.mp4");
    await retype(page, "#result-segments li:first-child .seg__text", "Cambiado");
    expect(await page.$eval("#burn-start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(await text(page, "#burn-hint")).toContain("Guarda los cambios");
    await page.click("#editor-save");
    await page.waitForFunction(() => (document.querySelector("#editor-state")?.textContent ?? "").includes("Cambios guardados"), { timeout: 10_000 });
    expect(await page.$eval("#burn-start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(false);
    await page.close();
  }, 60_000);

  it("quemado: un fallo se explica en el idioma de la interfaz y se puede volver a intentar", async () => {
    const base = await startApi();
    const { page, jobId } = await openEditorFor(base, "falla-quema.mp4");
    await page.click("#burn-start");
    await page.waitForSelector("#burn-panel:not([hidden])", { timeout: 15_000 });
    const burn = await burnJobOf(jobId);
    await prisma.job.update({ where: { id: burn.id }, data: { status: "FAILED", errorCode: "FFMPEG_FAILED", errorMessage: "fuente no encontrada", finishedAt: new Date() } });
    await page.waitForFunction(() => (document.querySelector("#burn-status")?.textContent ?? "").includes("No se pudo leer el audio"), { timeout: 10_000 });
    expect(await page.$eval("#burn-panel", (panel) => panel.classList.contains("is-failed"))).toBe(true);
    expect(await isVisible(page, "#burn-video")).toBe(false);
    expect(await page.$eval("#burn-start", (button) => (button as unknown as { disabled: boolean }).disabled)).toBe(false);
    await page.close();
  }, 60_000);

  it("quemado: abrir un video con subtítulos desde «Recientes» lo muestra y permite volver a sus subtítulos", async () => {
    const base = await startApi();
    const { page, jobId } = await openEditorFor(base, "vuelve.mp4");
    await page.click("#burn-start");
    await page.waitForSelector("#burn-panel:not([hidden])", { timeout: 15_000 });
    const burn = await burnJobOf(jobId);
    await workerFinishesBurn(burn.id);
    await page.waitForFunction(() => (document.querySelector("#burn-status")?.textContent ?? "").includes("Video listo"), { timeout: 10_000 });

    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.$$eval("#history-list li", (items) => items.length)).toBe(2);
    // El más reciente es el quemado.
    await page.click("#history-list li:first-child .btn--secondary");
    await page.waitForFunction(() => (document.querySelector("#burn-status")?.textContent ?? "").includes("Video listo"), { timeout: 10_000 });
    expect(await isVisible(page, "#job-panel")).toBe(false);
    expect(await isVisible(page, "#result-panel")).toBe(false);
    expect(await isVisible(page, "#burn-open-parent")).toBe(true);

    await page.click("#burn-open-parent");
    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll("#result-segments li").length === 3, { timeout: 15_000 });
    expect(await isVisible(page, "#burn-panel")).toBe(false);
    await page.close();
  }, 90_000);

  it("editor: «Cargar la versión nueva» en un conflicto descarta lo local y muestra lo del servidor", async () => {
    const base = await startApi();
    const { page, jobId } = await openEditorFor(base, "recarga.mp4");
    await fetch(`${base}/v1/jobs/${jobId}/segments`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ segments: [{ index: 2, text: "Versión del servidor" }] }),
    });
    await retype(page, "#result-segments li:first-child .seg__text", "Descartable");
    await page.click("#editor-save");
    await page.waitForSelector("#editor-conflict:not([hidden])", { timeout: 10_000 });
    page.once("dialog", (dialog) => void dialog.accept()); // confirma descartar los cambios locales
    await page.click("#editor-reload");
    await page.waitForFunction(() => (document.querySelector("#editor-state")?.textContent ?? "").includes("versión del servidor"), { timeout: 10_000 });
    expect(await rowValue(page, "#result-segments li:first-child .seg__text")).toBe(" Hola & bienvenidos <b>todos</b>");
    expect(await rowValue(page, "#result-segments li:nth-child(3) .seg__text")).toBe("Versión del servidor");
    await page.close();
  }, 60_000);

  it("historial: lo subido queda en «Recientes», sobrevive a recargar y «Abrir» retoma el trabajo; «Quitar» lo borra", async () => {
    const base = await startApi();
    const { page, spy } = await openPage(base);
    const name = "historial.mp4";
    await uploadAndFollow(page, name);
    await workerCompletes(name, SEGMENTS);
    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    expect(await page.$$eval("#history-list li", (items) => items.length)).toBe(1);
    expect(await text(page, "#history-list li")).toContain(name);

    await page.reload({ waitUntil: "networkidle0" });
    expect(await isVisible(page, "#job-panel")).toBe(false);
    expect(await page.$$eval("#history-list li", (items) => items.length)).toBe(1);
    await page.click("#history-list li .btn--secondary");
    await page.waitForSelector("#result-panel:not([hidden])", { timeout: 15_000 });
    await waitForJobText(page, "Listo");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("job-panel");

    await page.click("#history-list li .btn--ghost");
    expect(await page.$$eval("#history-list li", (items) => items.length)).toBe(0);
    expect(await isVisible(page, "#history-empty")).toBe(true);
    expect(spy.problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("historial: un trabajo que el servidor ya no tiene se dice sin dejar la interfaz colgada", async () => {
    const base = await startApi();
    const { page } = await openPage(base);
    const ghost = randomUUID();
    await page.evaluate((id) => localStorage.setItem("captionforge_jobs", JSON.stringify([{ id, name: "caducado.mp4", kind: "TRANSCRIBE", at: Date.now() }])), ghost);
    await page.reload({ waitUntil: "networkidle0" });
    await page.click("#history-list li .btn--secondary");
    await waitForJobText(page, "no encuentra este trabajo");
    expect(await isVisible(page, "#job-reconnect")).toBe(false);
    expect(await isVisible(page, "#result-panel")).toBe(false);
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
