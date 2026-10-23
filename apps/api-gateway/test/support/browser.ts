// Cierre robusto de Chrome para las pruebas de navegador. En Windows con poca memoria `browser.close()` a veces no vuelve (limpieza del
// perfil temporal), y el `afterAll` agotaba su plazo de 60 s dejando el archivo entero como fallido sin que fallara ninguna prueba.
import type { Browser } from "puppeteer-core";

const CLOSE_GRACE_MS = 10_000;

/** Cierra el navegador con un tope; si no responde, mata el proceso. Nunca lanza ni bloquea el resto de la limpieza. */
export async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (browser === undefined) return;
  const child = browser.process();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
