// Panel «Claves externas» (T10, ADR 0020) en un navegador real, con clics sobre el DOM: la Dueña guarda, reemplaza y borra la clave de
// OpenAI; la clave nunca queda en la página; y en modo local (clave de este navegador, sin sesión) el panel ni existe ni consulta la red.
// Se omite si no hay Chrome o Edge.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";

import pg from "pg";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { closeBrowser } from "./support/browser.js";
import { FakeProvider, type FakeProfile } from "./support/fake-provider.js";
import { createTestTenant } from "./support/tenancy.js";

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
const provider = new FakeProvider();
const ANA_ID = 4_000_000 + Math.floor(Math.random() * 100_000);
const ANA: FakeProfile = { id: ANA_ID, login: `ek-${ANA_ID}`, name: "Ana Dueña", emails: [{ email: `ek-${ANA_ID}@example.com`, primary: true, verified: true }] };
const FIRST = `sk-primera-${randomBytes(18).toString("hex")}`;
const SECOND = `sk-segunda-${randomBytes(18).toString("hex")}`;

let sessionApp: Awaited<ReturnType<typeof createApp>>;
let localApp: Awaited<ReturnType<typeof createApp>>;
let sessionBase = "";
let localBase = "";
let browser: Browser;
let owner: pg.Client;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

type Doc = { getElementById(id: string): { hidden: boolean; children: { length: number } } };
const press = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { click(): void }).click());
const hidden = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { hidden: boolean }).hidden);
const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
const waitFor = (page: Page, selector: string, want: "visible" | "hidden") =>
  page.waitForFunction(
    (sel: string, state: string) => {
      const element = (globalThis as unknown as { document: { querySelector(s: string): { hidden: boolean } | null } }).document.querySelector(sel);
      return element !== null && (state === "visible" ? !element.hidden : element.hidden);
    },
    { timeout: 15_000 },
    selector,
    want,
  );
const rowsReady = (page: Page, count: number) =>
  page.waitForFunction((n: number) => ((globalThis as unknown as { document: Doc }).document.getElementById("extkeys-list").children.length ?? 0) === n, { timeout: 15_000 }, count);
/** Espera a que el texto de la lista cumpla un patrón (la lista se vuelve a pintar tras cada operación). */
const listMatches = (page: Page, pattern: string) =>
  page.waitForFunction((source: string) => new RegExp(source).test((globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById("extkeys-list").textContent), { timeout: 15_000 }, pattern);
const stored = async (tenantId: string) =>
  (await owner.query<{ provider: string; last4: string; ciphertext: string }>(`SELECT provider::text AS provider, last4, ciphertext FROM "TenantExternalKey" WHERE "tenantId" = $1 ORDER BY provider`, [tenantId])).rows;
/** Todo lo que hay en la página: texto, valores de los campos y atributos. */
const pageDump = (page: Page) =>
  page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { documentElement: { outerHTML: string }; querySelectorAll(s: string): { value: string }[] } }).document;
    return [doc.documentElement.outerHTML, ...[...doc.querySelectorAll("input")].map((input) => input.value)].join("\n");
  });

async function openPage(base: string, problems: string[], failures: string[]): Promise<Page> {
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
  // Los "Failed to load resource" de la consola no dicen qué URL fue: se vigilan las respuestas HTTP (ver `failures`).
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`consola: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`);
  });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  return page;
}

describe.skipIf(browserPath === undefined)("claves externas en un navegador real", () => {
  beforeAll(async () => {
    await provider.start();
    const sessionPort = await freePort();
    sessionBase = `http://127.0.0.1:${sessionPort}`;
    sessionApp = await createApp(
      {
        ...baseConfig,
        reaper: { ...baseConfig.reaper, intervalMs: 0 },
        auth: { ...baseConfig.auth, localMode: false, publicUrl: sessionBase, providers: { github: provider.config } },
        byok: { ...baseConfig.byok, appSecret: APP_SECRET },
        security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0 },
      },
      { logger: ["error"] },
    );
    await sessionApp.listen(sessionPort, "127.0.0.1");

    const tenant = await createTestTenant("extkeys-local");
    const localPort = await freePort();
    localBase = `http://127.0.0.1:${localPort}`;
    localApp = await createApp(
      {
        ...baseConfig,
        reaper: { ...baseConfig.reaper, intervalMs: 0 },
        byok: { ...baseConfig.byok, appSecret: APP_SECRET }, // aunque el servidor tenga APP_SECRET, el modo local no ofrece BYOK en la interfaz
        security: { ...baseConfig.security, webApiKey: tenant.apiKey, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0 },
      },
      { logger: ["error"] },
    );
    await localApp.listen(localPort, "127.0.0.1");

    owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await owner.connect();
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  }, 60_000);

  afterAll(async () => {
    await closeBrowser(browser);
    if (owner !== undefined) {
      const users = await owner.query<{ id: string; tenantId: string }>(`SELECT id, "tenantId" FROM "User" WHERE provider = 'github' AND subject = $1`, [String(ANA.id)]);
      const tenants = users.rows.map((row) => row.tenantId);
      await owner.query(`DELETE FROM "TenantExternalKey" WHERE "tenantId" = ANY($1::uuid[])`, [tenants]);
      await owner.query(`DELETE FROM "Session" WHERE "userId" = ANY($1::uuid[])`, [users.rows.map((row) => row.id)]);
      await owner.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [users.rows.map((row) => row.id)]);
      await owner.query(`DELETE FROM "Tenant" WHERE id = ANY($1::uuid[])`, [tenants]);
      await owner.end();
    }
    await Promise.all([sessionApp?.close(), localApp?.close()]);
    await provider.stop();
  }, 60_000);

  it("la Dueña guarda, reemplaza y borra la clave sin que quede rastro en la página", async () => {
    provider.autoApprove = ANA;
    const problems: string[] = [];
    const failures: string[] = [];
    const page = await openPage(sessionBase, problems, failures);
    await page.waitForSelector("#login-github:not([hidden])");
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), press(page, "#login-github")]);
    await waitFor(page, "#account-bar", "visible");
    const tenantId = (await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "User" WHERE subject = $1`, [String(ANA.id)])).rows[0]!.tenantId;

    // El botón aparece cuando el servidor confirma BYOK; el panel sigue cerrado hasta pulsarlo.
    await waitFor(page, "#account-extkeys-toggle", "visible");
    expect(await hidden(page, "#extkeys-panel")).toBe(true);
    await press(page, "#account-extkeys-toggle");
    await waitFor(page, "#extkeys-panel", "visible");
    await rowsReady(page, 2);
    expect(await page.$eval("#account-extkeys-toggle", (el) => el.getAttribute("aria-expanded"))).toBe("true");
    expect(await text(page, "#extkeys-list")).toContain("Sin clave");

    // Los campos son password, sin autocompletado, y nacen vacíos.
    const attrs = await page.$$eval('#extkeys-list input[data-field="key"]', (inputs) => inputs.map((input) => [input.getAttribute("type"), input.getAttribute("autocomplete"), (input as unknown as { value: string }).value]));
    expect(attrs).toEqual([["password", "off", ""], ["password", "off", ""]]);

    // Guardar con el campo vacío no manda nada y lo explica.
    await press(page, '[data-action="save"][data-provider="openai"]');
    await waitFor(page, "#extkeys-problem", "visible");
    expect(await text(page, "#extkeys-problem")).toContain("Pega la clave");
    expect(await stored(tenantId)).toHaveLength(0);

    // Una clave con formato inválido se rechaza con texto propio, sin repetirla.
    await page.type('[data-field="key"][data-provider="openai"]', "esto-no-es-una-clave");
    await press(page, '[data-action="save"][data-provider="openai"]');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById("extkeys-problem").textContent ?? "").includes("formato"), { timeout: 15_000 });
    expect(await text(page, "#extkeys-problem")).not.toContain("esto-no-es-una-clave");
    expect(await stored(tenantId)).toHaveLength(0);

    // Una clave válida: se guarda cifrada, el campo se vacía y solo se ve «…últimos 4».
    await page.$eval('[data-field="key"][data-provider="openai"]', (input) => ((input as unknown as { value: string }).value = ""));
    await page.type('[data-field="key"][data-provider="openai"]', FIRST);
    await press(page, '[data-action="save"][data-provider="openai"]');
    await listMatches(page, `…${FIRST.slice(-4)}`);
    const rows = await stored(tenantId);
    expect(rows.map((row) => [row.provider, row.last4])).toEqual([["openai", FIRST.slice(-4)]]);
    expect(rows[0]!.ciphertext).not.toContain(FIRST);
    expect(await page.$eval('[data-field="key"][data-provider="openai"]', (input) => (input as unknown as { value: string }).value)).toBe("");
    expect(await text(page, '[data-action="save"][data-provider="openai"]')).toBe("Reemplazar");
    expect(await pageDump(page)).not.toContain(FIRST);

    // Reemplazar cambia los últimos 4.
    await page.type('[data-field="key"][data-provider="openai"]', SECOND);
    await press(page, '[data-action="save"][data-provider="openai"]');
    await listMatches(page, `…${SECOND.slice(-4)}`);
    expect((await stored(tenantId)).map((row) => row.last4)).toEqual([SECOND.slice(-4)]);
    const dump = await pageDump(page);
    expect(dump).not.toContain(FIRST);
    expect(dump).not.toContain(SECOND);

    // Menú de servicios + URL base y modelo propios (ADR 0022): solo la fila de OpenAI los tiene, y se ve el servidor (nunca la URL completa).
    const value = (selector: string) => page.$eval(selector, (input) => (input as unknown as { value: string }).value);
    expect(await page.$$eval('#extkeys-list input[data-field="baseUrl"], #extkeys-list input[data-field="model"], #extkeys-list select[data-field="preset"]', (inputs) => inputs.map((input) => input.getAttribute("data-provider")))).toEqual(["openai", "openai", "openai"]);
    expect(await text(page, "#extkeys-help-openai")).toMatch(/DeepSeek.*Groq/s);
    expect(await page.$$eval('[data-field="preset"] option', (options) => options.map((option) => option.getAttribute("value")))).toEqual(["openai", "deepseek", "gemini", "anthropic", "groq", "openrouter", "abacus", "custom"]); // Ollama no: el servidor de la prueba no admite direcciones locales
    await page.select('[data-field="preset"][data-provider="openai"]', "deepseek");
    expect(await value('[data-field="baseUrl"][data-provider="openai"]')).toBe("https://api.deepseek.com/v1");
    expect(await value('[data-field="model"][data-provider="openai"]')).toBe("deepseek-chat");
    expect(await page.$$eval("#extkeys-models-openai option", (options) => options.map((option) => option.getAttribute("value")))).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(await page.$eval('[data-field="model"][data-provider="openai"]', (input) => input.getAttribute("list"))).toBe("extkeys-models-openai");
    await page.type('[data-field="key"][data-provider="openai"]', SECOND);
    await press(page, '[data-action="save"][data-provider="openai"]');
    await listMatches(page, "api\\.deepseek\\.com");
    const custom = await owner.query<{ baseUrlHost: string | null; baseUrlCiphertext: string | null; model: string | null }>(`SELECT "baseUrlHost", "baseUrlCiphertext", model FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId]);
    expect(custom.rows[0]!.baseUrlHost).toBe("api.deepseek.com");
    expect(custom.rows[0]!.model).toBe("deepseek-chat");
    expect(custom.rows[0]!.baseUrlCiphertext).not.toContain("deepseek");
    const state = await text(page, "#extkeys-state-openai");
    expect(state).toContain("deepseek-chat");
    expect(state).not.toContain("/v1");
    // Con un servidor conocido guardado, el menú vuelve a mostrarlo con su URL y su modelo: se reemplaza la clave sin retocar nada.
    expect(await value('[data-field="preset"][data-provider="openai"]')).toBe("deepseek");
    expect(await value('[data-field="baseUrl"][data-provider="openai"]')).toBe("https://api.deepseek.com/v1");
    expect(await value('[data-field="model"][data-provider="openai"]')).toBe("deepseek-chat");
    // Una URL base inválida se rechaza con texto propio y no cambia lo guardado.
    await page.$eval('[data-field="baseUrl"][data-provider="openai"]', (input) => ((input as unknown as { value: string }).value = ""));
    await page.type('[data-field="key"][data-provider="openai"]', SECOND);
    await page.type('[data-field="baseUrl"][data-provider="openai"]', "http://127.0.0.1:11434/v1");
    expect(await value('[data-field="preset"][data-provider="openai"]')).toBe("custom"); // una URL a mano que no es de un servicio conocido pasa a «otro»
    await press(page, '[data-action="save"][data-provider="openai"]');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById("extkeys-problem").textContent ?? "").includes("URL base"), { timeout: 15_000 });
    expect(await text(page, "#extkeys-problem")).not.toContain("127.0.0.1");
    expect((await owner.query(`SELECT "baseUrlHost" FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId])).rows[0]!.baseUrlHost).toBe("api.deepseek.com");
    // Volver a «OpenAI» en el menú vacía la URL y el modelo sugerido: un reemplazo es completo.
    await page.select('[data-field="preset"][data-provider="openai"]', "openai");
    expect(await value('[data-field="baseUrl"][data-provider="openai"]')).toBe("");
    expect(await value('[data-field="model"][data-provider="openai"]')).toBe("");
    await press(page, '[data-action="save"][data-provider="openai"]');
    await page.waitForFunction(() => !((globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById("extkeys-state-openai").textContent ?? "").includes("api.deepseek.com"), { timeout: 15_000 });
    expect((await owner.query(`SELECT "baseUrlHost", "baseUrlCiphertext", model FROM "TenantExternalKey" WHERE "tenantId" = $1`, [tenantId])).rows[0]).toEqual({ baseUrlHost: null, baseUrlCiphertext: null, model: null });

    // Borrar pide una segunda pulsación.
    await press(page, '[data-action="delete"][data-provider="openai"]');
    expect(await stored(tenantId)).toHaveLength(1);
    expect(await text(page, '[data-action="delete"][data-provider="openai"]')).toContain("Seguro");
    await press(page, '[data-action="delete"][data-provider="openai"]');
    await listMatches(page, "Sin clave.*Sin clave");
    expect(await stored(tenantId)).toHaveLength(0);

    expect(problems).toEqual([]);
    // Lo único que falla es lo que la prueba provoca a propósito (formato inválido) la comprobación de sesión previa al inicio y el web-config.json opcional.
    expect(failures.filter((entry) => !entry.startsWith("GET /v1/me ") && !entry.startsWith("GET /v1/capabilities ") && !entry.startsWith("GET /web-config.json "))).toEqual(["PUT /v1/workspaces/current/external-keys/openai 400", "PUT /v1/workspaces/current/external-keys/openai 400"]);
  }, 120_000);

  it("en modo local el panel no existe y la página no consulta las claves aunque el servidor tenga APP_SECRET", async () => {
    const problems: string[] = [];
    const requested: string[] = [];
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on("request", (request) => requested.push(request.url()));
    page.on("pageerror", (error) => problems.push(`excepción: ${String(error)}`));
    await page.goto(`${localBase}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !(globalThis as unknown as { document: Doc }).document.getElementById("app-content").hidden, { timeout: 15_000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 });
    expect(await hidden(page, "#account-extkeys-toggle")).toBe(true);
    expect(await hidden(page, "#extkeys-panel")).toBe(true);
    expect(requested.filter((url) => url.includes("/v1/workspaces/current/external-keys"))).toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);
});
