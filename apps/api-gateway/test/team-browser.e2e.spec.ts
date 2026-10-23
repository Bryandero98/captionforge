// Equipos de punta a punta en un navegador real (ADR 0019): una Dueña invita con un enlace, otra persona lo abre SIN sesión, inicia
// sesión (proveedor falso con PKCE de verdad), la invitación se consume sola, y la Dueña cambia roles y expulsa. Cada persona usa
// un contexto de navegador aparte (sus cookies no se mezclan). Se omite si no hay Chrome o Edge.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";

import pg from "pg";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { createApp } from "../src/main.js";
import { FakeProvider, type FakeProfile } from "./support/fake-provider.js";

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
const FIRST_ID = 3_000_000 + Math.floor(Math.random() * 100_000);
const profile = (offset: number, name: string): FakeProfile => ({ id: FIRST_ID + offset, login: `eq-${FIRST_ID + offset}`, name, emails: [{ email: `eq-${FIRST_ID + offset}@example.com`, primary: true, verified: true }] });
const ANA = profile(0, "Ana Dueña");
const BETO = profile(1, "Beto Invitado");
const CARLA = profile(2, "Carla Tarde");
const DANI = profile(3, "Dani Curiosa");

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

type Doc = { getElementById(id: string): { hidden: boolean; textContent: string | null; value: string; children: { length: number } } };
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: Doc }).document;
    // La barra de cuenta (sesión) o la pantalla de entrada: las fija createAccount de golpe. #app-content puede verse antes de que el JS arranque.
    return !doc.getElementById("login-panel").hidden || !doc.getElementById("account-bar").hidden;
  });
const hidden = (page: Page, selector: string) => page.$eval(selector, (element) => (element as unknown as { hidden: boolean }).hidden);
const text = (page: Page, selector: string) => page.$eval(selector, (element) => element.textContent ?? "");
/** Espera a que un elemento tenga texto (la app se muestra un instante antes de pintar rol y avisos). */
const textOf = async (page: Page, selector: string): Promise<string> => {
  await page.waitForFunction(
    (sel: string) => ((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? "") !== "",
    {},
    selector,
  );
  return text(page, selector);
};
const waitFor = (page: Page, selector: string, predicate: "visible" | "hidden") =>
  page.waitForFunction(
    (sel: string, want: string) => {
      const element = (globalThis as unknown as { document: { querySelector(s: string): { hidden: boolean } | null } }).document.querySelector(sel);
      return element !== null && (want === "visible" ? !element.hidden : element.hidden);
    },
    {},
    selector,
    predicate,
  );

const dialogOpen = (page: Page) => page.$eval("#invite-confirm", (element) => (element as unknown as { open: boolean }).open);
/** Espera a que la pantalla de confirmación esté abierta: `settled` puede resolver antes de que la página termine de arrancar. */
const dialogShown = (page: Page) =>
  page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { open?: boolean } | null } }).document.getElementById("invite-confirm")?.open === true, { timeout: 15_000 });
const savedInvite = (page: Page) => page.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("cf_invite"));
const memberRole = async (subject: number, tenantId: string): Promise<string | undefined> =>
  (await owner.query<{ role: string }>(`SELECT m.role::text AS role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE u.subject = $1 AND m."tenantId" = $2`, [String(subject), tenantId])).rows[0]?.role;

/** Una persona = un contexto de navegador propio y una página en español. El proveedor falso aprueba como esa persona. */
async function open(who: FakeProfile, path = "/") {
  provider.autoApprove = who;
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("captionforge_lang", "es");
    } catch {
      // sin almacenamiento
    }
  });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`excepción: ${String(error)}`));
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await settled(page);
  return { page, context, problems };
}

async function signInWithGithub(page: Page): Promise<void> {
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#login-github")]);
  await settled(page);
}

describe.skipIf(browserPath === undefined)("equipos en un navegador real", () => {
  beforeAll(async () => {
    await provider.start();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = await createApp(
      { ...baseConfig, reaper: { ...baseConfig.reaper, intervalMs: 0 }, auth: { ...baseConfig.auth, localMode: false, publicUrl: base, providers: { github: provider.config } }, security: { ...baseConfig.security, webApiKey: undefined, rateLimitPerMinute: 0, uploadRateLimitPerMinute: 0 } },
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
      const subjects = [ANA, BETO, CARLA, DANI].map((p) => String(p.id));
      const users = await owner.query<{ id: string; tenantId: string }>(`SELECT id, "tenantId" FROM "User" WHERE provider = 'github' AND subject = ANY($1::text[])`, [subjects]);
      const tenants = [...new Set(users.rows.map((row) => row.tenantId))];
      await owner.query(`DELETE FROM "Invitation" WHERE "tenantId" = ANY($1::uuid[])`, [tenants]);
      await owner.query(`DELETE FROM "Session" WHERE "userId" = ANY($1::uuid[])`, [users.rows.map((row) => row.id)]);
      await owner.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [users.rows.map((row) => row.id)]);
      await owner.query(`DELETE FROM "Tenant" WHERE id = ANY($1::uuid[])`, [tenants]);
      await owner.end();
    }
    await app?.close();
    await provider.stop();
  }, 60_000);

  it("invitar, unirse sin sesión previa, cambiar roles y expulsar", async () => {
    // ── 1. Ana entra, abre «Equipo» y crea un enlace de Editor.
    const ana = await open(ANA);
    await signInWithGithub(ana.page);
    expect(await textOf(ana.page, "#account-role")).toBe("Dueño");
    expect(await hidden(ana.page, "#account-team-toggle")).toBe(false);
    await ana.page.click("#account-team-toggle");
    await waitFor(ana.page, "#team-panel", "visible");
    await ana.page.select("#team-invite-role", "EDITOR");
    await ana.page.click("#team-invite-form button[type=submit]");
    await waitFor(ana.page, "#team-link-box", "visible");
    const link = await text(ana.page, "#team-link");
    expect(link).toMatch(/\/\?invite=cfi_[A-Za-z0-9_-]{43}$/);
    const teamId = (await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "User" WHERE subject = $1`, [String(ANA.id)])).rows[0]!.tenantId;

    // ── 2. Beto abre el enlace SIN sesión: ve la pantalla de entrada con el aviso, y el token ya no está en la barra de direcciones.
    const beto = await open(BETO, new URL(link).pathname + new URL(link).search);
    expect(await hidden(beto.page, "#login-panel")).toBe(false);
    expect(await hidden(beto.page, "#login-invite")).toBe(false);
    expect(beto.page.url()).not.toContain("invite=");
    expect(await beto.page.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("cf_invite"))).toMatch(/^cfi_/);

    // ── 3. Inicia sesión; al volver NO se une solo: ve «¿Deseas unirte a este espacio?» con el espacio y el rol, y nada ha cambiado aún.
    await signInWithGithub(beto.page);
    await dialogShown(beto.page);
    expect(await text(beto.page, "#invite-confirm-title")).toBe("¿Deseas unirte a este espacio?");
    expect(await text(beto.page, "#invite-confirm-body")).toContain("Ana Dueña");
    expect(await text(beto.page, "#invite-confirm-body")).toContain("Editor");
    expect(await memberRole(BETO.id, teamId), "mirar la invitación no une a nadie").toBeUndefined();
    expect(await savedInvite(beto.page)).toMatch(/^cfi_/);
    expect(await textOf(beto.page, "#account-role")).toBe("Dueño"); // sigue en su espacio propio hasta decidir

    // El clic explícito es lo que acepta; la página se recarga ya dentro del equipo de Ana.
    await Promise.all([beto.page.waitForNavigation({ waitUntil: "domcontentloaded" }), beto.page.click("#invite-confirm-join")]);
    await settled(beto.page);
    expect(await memberRole(BETO.id, teamId)).toBe("EDITOR");
    expect(await textOf(beto.page, "#account-notice")).toContain("Editor");
    expect(await hidden(beto.page, "#account-notice")).toBe(false);
    expect(await dialogOpen(beto.page)).toBe(false);
    expect(await textOf(beto.page, "#account-role")).toBe("Editor");
    expect(await savedInvite(beto.page)).toBeNull();
    // Un Editor no ve «Equipo» ni «Claves de API», pero sí el formulario de subida, y puede cambiar de espacio.
    expect(await hidden(beto.page, "#account-team-toggle")).toBe(true);
    expect(await hidden(beto.page, "#account-keys-toggle")).toBe(true);
    expect(await hidden(beto.page, "#upload-form")).toBe(false);
    expect(await hidden(beto.page, "#workspace-select")).toBe(false);
    expect(await beto.page.$$eval("#workspace-select option", (options) => options.length)).toBe(2);
    expect(await beto.page.$eval("#workspace-select", (select) => (select as unknown as { value: string }).value)).toBe(teamId);

    // ── 4. Carla usa el MISMO enlace después: ya no sirve (un solo uso) y no entra.
    const carla = await open(CARLA, new URL(link).pathname + new URL(link).search);
    await signInWithGithub(carla.page);
    expect(await textOf(carla.page, "#account-notice")).toMatch(/ya se usó|venció|revocado/i);
    expect(await dialogOpen(carla.page), "un enlace gastado no ofrece unirse").toBe(false);
    expect(await memberRole(CARLA.id, teamId)).toBeUndefined();
    expect(await savedInvite(carla.page)).toBeNull();
    expect(await textOf(carla.page, "#account-role")).toBe("Dueño"); // sigue en su espacio propio
    expect(await hidden(carla.page, "#workspace-select")).toBe(true);

    // ── 5. Ana ve a Beto en el equipo y lo pasa a Lector.
    await ana.page.reload({ waitUntil: "domcontentloaded" });
    await settled(ana.page);
    await ana.page.click("#account-team-toggle");
    await ana.page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById("team-members").children.length === 2);
    await ana.page.select("#team-members li:nth-child(2) select", "VIEWER");
    await ana.page.waitForFunction(() => {
      const select = (globalThis as unknown as { document: { querySelector(s: string): { value: string } | null } }).document.querySelector("#team-members li:nth-child(2) select");
      return select?.value === "VIEWER";
    });
    const betoRole = async () => (await owner.query<{ role: string }>(`SELECT m.role::text AS role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE u.subject = $1 AND m."tenantId" = $2`, [String(BETO.id), teamId])).rows[0]?.role;
    await expect.poll(betoRole).toBe("VIEWER");

    // Beto recarga: ahora es Lector. Ve su aviso y ya no tiene formulario de subida.
    await beto.page.reload({ waitUntil: "domcontentloaded" });
    await settled(beto.page);
    expect(await textOf(beto.page, "#account-role")).toBe("Lector");
    expect(await hidden(beto.page, "#role-note")).toBe(false);
    expect(await hidden(beto.page, "#upload-form")).toBe(true);

    // ── 6. Ana lo expulsa (pide confirmar: dos pulsaciones). Beto vuelve a su espacio propio, como Dueño de lo suyo.
    await ana.page.click("#team-members li:nth-child(2) button");
    expect(await betoRole()).toBe("VIEWER"); // la primera pulsación solo pide confirmar
    await ana.page.click("#team-members li:nth-child(2) button");
    await expect.poll(betoRole).toBeUndefined();
    await beto.page.reload({ waitUntil: "domcontentloaded" });
    await settled(beto.page);
    expect(await textOf(beto.page, "#account-role")).toBe("Dueño");
    expect(await hidden(beto.page, "#workspace-select")).toBe(true);

    // ── 7. Ana no puede degradarse a sí misma: es la única Dueña (409), y la interfaz lo explica.
    await ana.page.reload({ waitUntil: "domcontentloaded" });
    await settled(ana.page);
    await ana.page.click("#account-team-toggle");
    await ana.page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById("team-members").children.length === 1);
    await ana.page.select("#team-members li:nth-child(1) select", "EDITOR");
    await ana.page.waitForFunction(() => !(globalThis as unknown as { document: Doc }).document.getElementById("team-problem").hidden);
    expect(await text(ana.page, "#team-problem")).toContain("sin Dueño");
    expect(ana.problems).toEqual([]);
    expect(beto.problems).toEqual([]);
    for (const person of [ana, beto, carla]) await person.context.close();
  }, 120_000);

  it("quien YA tiene sesión y abre un enlace ajeno ve la confirmación: «Ahora no» no lo une a nada y limpia el enlace", async () => {
    const boss = await open(ANA);
    await signInWithGithub(boss.page);
    await boss.page.click("#account-team-toggle");
    await waitFor(boss.page, "#team-panel", "visible");
    await boss.page.select("#team-invite-role", "VIEWER");
    await boss.page.click("#team-invite-form button[type=submit]");
    await waitFor(boss.page, "#team-link-box", "visible");
    const link = new URL(await text(boss.page, "#team-link"));
    const tenantOfAna = (await owner.query<{ tenantId: string }>(`SELECT "tenantId" FROM "User" WHERE subject = $1`, [String(ANA.id)])).rows[0]!.tenantId;

    const guest = await open(DANI);
    await signInWithGithub(guest.page);
    await textOf(guest.page, "#account-role"); // la app ya arrancó: la comprobación siguiente no pasa en vacío
    expect(await dialogOpen(guest.page)).toBe(false);
    await guest.page.goto(`${base}${link.pathname}${link.search}`, { waitUntil: "domcontentloaded" });
    await settled(guest.page);
    await dialogShown(guest.page);
    expect(await dialogOpen(guest.page), "un enlace plantado no se consume solo").toBe(true);
    expect(await memberRole(DANI.id, tenantOfAna)).toBeUndefined();
    await guest.page.click("#invite-confirm-decline");
    expect(await dialogOpen(guest.page)).toBe(false);
    expect(await savedInvite(guest.page)).toBeNull();
    await guest.page.reload({ waitUntil: "domcontentloaded" });
    await settled(guest.page);
    await textOf(guest.page, "#account-role");
    expect(await dialogOpen(guest.page), "tras rechazar no vuelve a preguntar").toBe(false);
    expect(await memberRole(DANI.id, tenantOfAna)).toBeUndefined();
    expect(await hidden(guest.page, "#workspace-select")).toBe(true);
    for (const person of [boss, guest]) await person.context.close();
  }, 90_000);

  it("un enlace inexistente no rompe nada: tras iniciar sesión se avisa y se sigue en el espacio propio", async () => {
    const fake = `/?invite=cfi_${randomUUID().replaceAll("-", "").padEnd(43, "x").slice(0, 43)}`;
    const person = await open(CARLA, fake);
    await signInWithGithub(person.page);
    expect(await textOf(person.page, "#account-notice")).toMatch(/ya se usó|venció|revocado/i);
    expect(await dialogOpen(person.page)).toBe(false);
    expect(await savedInvite(person.page)).toBeNull();
    expect(await textOf(person.page, "#account-role")).toBe("Dueño");
    await person.context.close();
  }, 60_000);
});
