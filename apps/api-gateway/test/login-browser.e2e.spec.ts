// Inicio de sesión de punta a punta en un navegador real (ADR 0016): pantalla de entrada, ida y vuelta por el proveedor
// (falso, con PKCE de verdad), barra de cuenta, claves de API y cierre de sesión. Se omite si no hay Chrome o Edge.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";

import pg from "pg";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/main.js";
import { loadConfig } from "../src/config/config.js";
import { FakeProvider } from "./support/fake-provider.js";

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
const provider = new FakeProvider();
const GITHUB_ID = 2_000_000 + Math.floor(Math.random() * 100_000);
let app: Awaited<ReturnType<typeof createApp>>;
let base = "";
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

const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
const hidden = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { hidden: boolean }).hidden);

/** La página decide al cargar cómo entra: espera a que muestre la pantalla de entrada o la app. */
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } } }).document;
    return !doc.getElementById("login-panel").hidden || !doc.getElementById("app-content").hidden;
  });

/** Página con el idioma fijado en español y vigilancia de errores reales (los 401/404 esperados de la entrada no cuentan). */
async function openPage(path = "/"): Promise<{ page: Page; problems: string[] }> {
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource: the server responded with a status of (401|404)/.test(message.text())) problems.push(`consola: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`excepción: ${String(error)}`));
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("captionforge_lang", "es");
    } catch {
      // sin almacenamiento: queda el idioma del navegador
    }
  });
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await settled(page);
  return { page, problems };
}

describe.skipIf(browserPath === undefined)("inicio de sesión en un navegador real", () => {
  beforeAll(async () => {
    await provider.start();
    provider.autoApprove = { id: GITHUB_ID, login: `nav-${randomUUID().slice(0, 8)}`, name: "Ana Navegador", emails: [{ email: `nav-${GITHUB_ID}@example.com`, primary: true, verified: true }] };
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = await createApp(
      { ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, auth: { ...baseConfig.auth, localMode: false, publicUrl: base, providers: { github: provider.config } }, security: { ...baseConfig.security, webApiKey: undefined, allowedOrigins: [], allowedHosts: ["localhost", "127.0.0.1", "[::1]"] } },
      { logger: ["error"] },
    );
    await app.listen(port, "127.0.0.1");
    owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await owner.connect();
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (owner !== undefined) {
      const users = await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "User" WHERE provider = 'github' AND subject = $1`, [String(GITHUB_ID)]);
      for (const { tenantId } of users.rows) {
        await owner.query(`DELETE FROM "ApiKey" WHERE "tenantId" = $1`, [tenantId]);
        await owner.query(`DELETE FROM "Session" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = $1)`, [tenantId]);
        await owner.query(`DELETE FROM "User" WHERE "tenantId" = $1`, [tenantId]);
        await owner.query(`DELETE FROM "Tenant" WHERE id = $1`, [tenantId]);
      }
      await owner.end();
    }
    await app?.close();
    await provider.stop();
  }, 60_000);

  it("sin sesión muestra solo la pantalla de entrada, con GitHub y sin Google", async () => {
    const { page, problems } = await openPage();
    expect(await hidden(page, "#login-panel")).toBe(false);
    expect(await hidden(page, "#app-content")).toBe(true);
    expect(await hidden(page, "#account-bar")).toBe(true);
    expect(await hidden(page, "#login-github")).toBe(false);
    expect(await hidden(page, "#login-google")).toBe(true);
    expect(await text(page, "#login-github")).toBe("Continuar con GitHub");
    expect(problems).toEqual([]);
    await page.close();
  });

  it("un ?login_error= conocido se explica en la pantalla de entrada", async () => {
    const { page } = await openPage("/?login_error=denied");
    expect(await hidden(page, "#login-error")).toBe(false);
    expect(await text(page, "#login-error")).toContain("Cancelaste");
    await page.close();
  });

  it("entrar con GitHub, crear y revocar una clave, recargar y salir", async () => {
    const { page, problems } = await openPage();
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#login-github")]);
    await settled(page);

    // Dentro: la app y la barra con el nombre; la pantalla de entrada desaparece.
    expect(await hidden(page, "#login-panel")).toBe(true);
    expect(await hidden(page, "#app-content")).toBe(false);
    expect(await hidden(page, "#account-bar")).toBe(false);
    expect(await text(page, "#account-name")).toContain("Ana Navegador");

    // La cookie de sesión no es legible desde JavaScript (HttpOnly).
    expect(await page.evaluate(() => (globalThis as unknown as { document: { cookie: string } }).document.cookie)).not.toContain("cf_session");

    // Panel de claves: se abre, está vacío y se crea una.
    await page.click("#account-keys-toggle");
    await page.waitForFunction(() => !(globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } } }).document.getElementById("keys-empty").hidden);
    await page.type("#keys-name", "mi script");
    await page.click("#keys-create");
    await page.waitForFunction(() => !(globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } } }).document.getElementById("keys-created").hidden);
    const created = await text(page, "#keys-created-value");
    expect(created).toMatch(/^cfk_[A-Za-z0-9_-]{40,}$/);
    await page.waitForSelector(".keys__item");
    expect(await page.$$eval(".keys__item", (items) => items.length)).toBe(1);

    // Revocar: la fila queda marcada y sin botón.
    await page.click(".keys__item .btn");
    await page.waitForSelector(".keys__item.is-revoked");
    expect(await page.$$eval(".keys__item .btn", (buttons) => buttons.length)).toBe(0);

    // La clave creada funciona contra el API… y la revocada deja de funcionar.
    const sessionKeys = await page.evaluate(async () => (await fetch("/v1/keys", { credentials: "same-origin" })).status);
    expect(sessionKeys).toBe(200);
    expect((await fetch(`${base}/v1/jobs/${randomUUID()}`, { headers: { "x-api-key": created } })).status).toBe(401);

    // Recargar conserva la sesión.
    await page.reload({ waitUntil: "domcontentloaded" });
    await settled(page);
    expect(await hidden(page, "#account-bar")).toBe(false);

    // Salir vuelve a la pantalla de entrada y la sesión ya no sirve.
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#account-signout")]);
    await settled(page);
    expect(await hidden(page, "#login-panel")).toBe(false);
    expect(await hidden(page, "#app-content")).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
});
