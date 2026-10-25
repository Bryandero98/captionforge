// Asistente (v1.3.1, ADR 0028) en un navegador real, con una IA falsa en 127.0.0.1: configurar, conversar, no interpretar HTML,
// quitar y volver a mostrar, olvidar la clave, celular de 360 px y ausencia total fuera del modo local. Se omite si no hay Chrome o Edge.
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import net from "node:net";

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
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

// La configuración del .env puede traer líneas de una prueba manual (LOCAL_MODE, ALLOWED_*, PUBLIC_URL): aquí no cuentan.
const cleanEnv = { ...process.env, ALLOW_PRIVATE_BASE_URLS: "true" } as NodeJS.ProcessEnv;
for (const name of ["ALLOWED_HOSTS", "ALLOWED_ORIGINS", "PUBLIC_URL", "LOCAL_MODE"]) delete cleanEnv[name];
const baseConfig = loadConfig(cleanEnv);

const REPLY = "Pulsa <b>Traducirlos</b> y elige el idioma.";
const KEY = "test-key-12345678";

type Seen = { authorization: string | undefined; body: { model: string; messages: { role: string; content: string }[]; tools?: unknown } };

let app: Awaited<ReturnType<typeof createApp>>;
let remote: Awaited<ReturnType<typeof createApp>>;
let ai: Server;
let aiPort = 0;
let aiStatus = 200;
const seen: Seen[] = [];
let base = "";
let remoteBase = "";
let browser: Browser;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

type Dom = { document: { querySelector(s: string): { hidden: boolean; textContent: string | null } | null; querySelectorAll(s: string): { length: number }; documentElement: { scrollWidth: number; clientWidth: number } } };
const press = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { click(): void }).click());
const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
const prop = <T>(page: Page, selector: string, name: string): Promise<T> => page.$eval(selector, (element, key) => (element as unknown as Record<string, T>)[key as string] as T, name) as Promise<T>;
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
const overflow = (page: Page) => page.evaluate(() => (globalThis as unknown as Dom).document.documentElement.scrollWidth - (globalThis as unknown as Dom).document.documentElement.clientWidth);

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    request.on("end", () => resolve(data));
  });

async function open(problems: string[], root = base, mobile = false): Promise<Page> {
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
  if (mobile) await page.setViewport({ width: 360, height: 740, isMobile: true, deviceScaleFactor: 2 });
  await page.goto(`${root}/`, { waitUntil: "domcontentloaded" });
  return page;
}

async function configure(page: Page): Promise<void> {
  await press(page, "#assistant-open");
  await waitFor(page, "#assistant", "visible");
  await page.select("#assistant-service", "custom");
  await waitFor(page, "#assistant-url", "visible");
  await page.type("#assistant-url", `http://127.0.0.1:${aiPort}/v1`);
  await page.type("#assistant-key", KEY);
  await page.type("#assistant-model", "modelo-prueba");
  await press(page, "#assistant-save");
  await waitText(page, "#assistant-status", "Guardado en este navegador");
}

describe.skipIf(browserPath === undefined)("asistente en un navegador real", () => {
  beforeAll(async () => {
    ai = createServer((request, response) => {
      void readBody(request).then((raw) => {
        if (aiStatus !== 200) {
          response.writeHead(aiStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `rechazado ${KEY}` } }));
          return;
        }
        seen.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Seen["body"] });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }));
      });
    });
    await new Promise<void>((done) => ai.listen(0, "127.0.0.1", done));
    aiPort = (ai.address() as net.AddressInfo).port;

    const tenant = await createTestTenant("assistant-ui");
    const open_ = { rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0, tenantUploadsPerHour: 0, tenantMaxQueuedJobs: 0, maxConcurrentUploads: 0, maxConcurrentUploadsPerClient: 0, maxEventStreams: 0, maxEventStreamsPerClient: 0 };
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = await createApp({ ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, security: { ...baseConfig.security, ...open_, webApiKey: tenant.apiKey } }, { logger: ["error"] });
    await app.listen(port, "127.0.0.1");

    // Un servidor con inicio de sesión (LOCAL_MODE=false): el asistente no debe existir.
    const remotePort = await freePort();
    remoteBase = `http://127.0.0.1:${remotePort}`;
    remote = await createApp(
      { ...baseConfig, port: remotePort, auth: { ...baseConfig.auth, localMode: false }, reaper: { ...baseConfig.reaper, intervalMs: 0 }, security: { ...baseConfig.security, ...open_, webApiKey: undefined } },
      { logger: ["error"] },
    );
    await remote.listen(remotePort, "127.0.0.1");

    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  }, 90_000);

  afterAll(async () => {
    await closeBrowser(browser);
    await app?.close();
    await remote?.close();
    await new Promise<void>((done) => (ai ? ai.close(() => done()) : done()));
    await disposeTestTenants();
  }, 90_000);

  it("configura la IA, conversa, muestra la respuesta como texto y manda la clave solo a la IA elegida", async () => {
    const problems: string[] = [];
    const page = await open(problems);
    await waitFor(page, "#assistant-open", "visible");
    await configure(page);

    await page.type("#assistant-input", "¿Cómo traduzco?");
    await page.keyboard.press("Enter"); // Enter envía
    await waitText(page, "#assistant-log", "Traducirlos");
    expect(await count(page, "#assistant-log li")).toBe(2);
    expect(await count(page, "#assistant-log b")).toBe(0); // la respuesta es texto, no HTML
    expect(await text(page, "#assistant-log li:last-child")).toContain("<b>Traducirlos</b>");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body.model).toBe("modelo-prueba");
    expect(seen[0]?.body.messages[0]?.role).toBe("system");
    expect(seen[0]?.body.messages.at(-1)).toEqual({ role: "user", content: "¿Cómo traduzco?" });
    // Solo la lista cerrada de herramientas que PROPONEN acciones; el servidor no ejecuta nada.
    expect(((seen[0]?.body.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name).sort()).toEqual(["burn", "download_srt", "dub", "go_to_step", "translate"]);
    expect(problems).toEqual([]);
  }, 120_000);

  it("recuerda la IA al recargar, y si la IA falla avisa sin mostrar su respuesta ni la clave", async () => {
    const problems: string[] = [];
    const page = await open(problems);
    await configure(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(page, "#assistant-open", "visible");
    await press(page, "#assistant-open");
    expect(await prop<string>(page, "#assistant-key", "value")).toBe(KEY);

    aiStatus = 401;
    try {
      await page.type("#assistant-input", "hola");
      await press(page, "#assistant-send");
      await waitText(page, "#assistant-status", "Tu IA no respondió");
    } finally {
      aiStatus = 200;
    }
    expect(await text(page, "#assistant")).not.toContain("rechazado");
    expect(problems).toEqual([]);
  }, 120_000);

  it("se puede quitar y volver a mostrar desde la barra superior; olvidar la clave la borra del navegador", async () => {
    const problems: string[] = [];
    const page = await open(problems);
    await configure(page);

    await press(page, "#assistant-dismiss");
    await waitFor(page, "#assistant", "hidden");
    await waitFor(page, "#assistant-open", "hidden");
    await waitFor(page, "#assistant-restore", "visible");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(page, "#assistant-restore", "visible"); // la decisión se recuerda
    expect(await prop<boolean>(page, "#assistant-open", "hidden")).toBe(true);

    await press(page, "#assistant-restore");
    await waitFor(page, "#assistant", "visible");
    expect(await prop<boolean>(page, "#assistant-restore", "hidden")).toBe(true);
    expect(await prop<string>(page, "#assistant-key", "value")).toBe(KEY); // quitar el asistente no borra la clave

    await press(page, "#assistant-forget");
    await waitText(page, "#assistant-status", "Clave olvidada");
    const stored = await page.evaluate(() => localStorage.getItem("cf-assistant"));
    expect(stored).not.toContain(KEY);
    await page.type("#assistant-input", "hola");
    await press(page, "#assistant-send");
    await waitText(page, "#assistant-status", "Primero configura tu IA");
    expect(problems).toEqual([]);
  }, 120_000);

  it("en un celular de 360 px el panel no desborda la pantalla", async () => {
    const problems: string[] = [];
    const page = await open(problems, base, true);
    await configure(page);
    await page.type("#assistant-input", "¿Cómo doblo?");
    await press(page, "#assistant-send");
    await waitText(page, "#assistant-log", "Traducirlos");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const box = await page.$eval("#assistant", (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: (globalThis as unknown as { innerWidth: number }).innerWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.width);
    expect(problems).toEqual([]);
  }, 120_000);

  it("con inicio de sesión (LOCAL_MODE=false) el asistente no existe: ni botón ni rutas", async () => {
    const problems: string[] = [];
    const page = await open(problems, remoteBase);
    await page.waitForFunction(() => (globalThis as unknown as Dom).document.querySelector("#lang-es") !== null, { timeout: 20_000 });
    await new Promise((done) => setTimeout(done, 1500)); // deja que lleguen las capacidades
    expect(await prop<boolean>(page, "#assistant-open", "hidden")).toBe(true);
    expect(await prop<boolean>(page, "#assistant-restore", "hidden")).toBe(true);
    for (const path of ["/llms.txt", "/openapi.json"]) expect((await fetch(`${remoteBase}${path}`)).status).toBe(404);
    expect(problems).toEqual([]);
  }, 120_000);
});
