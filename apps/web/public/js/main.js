import { resolveAccess } from "./api/access.js";
import { brokenInviteInUrl, captureInvite, takeJoined } from "./api/invite.js";
import { checkPendingInvite } from "./api/join.js";
import { readConfig } from "./config.js";
import { createTranslator, detectLang } from "./i18n/index.js";
import { createAccount } from "./ui/account.js";
import { createApp } from "./ui/app.js";
import { createInviteConfirm } from "./ui/invite-confirm.js";

const config = readConfig(document);
// La clave de API se resuelve ANTES de arrancar la interfaz: sus primeras peticiones (capacidades, historial) ya la llevan.
/** @param {"localStorage" | "sessionStorage"} name @returns {Storage | null} */
const storageOf = (name) => {
  try {
    return window[name];
  } catch {
    return null; // modo privado o datos bloqueados: se sigue sin almacenamiento
  }
};
const storage = storageOf("localStorage");
const session = storageOf("sessionStorage");
// Cómo entra la página al API: clave local, sesión iniciada o pantalla de entrada (api/access.js).
// Una invitación (`/?invite=`) se guarda y se quita de la URL; sobrevive al viaje a GitHub o Google y de vuelta (ADR 0019).
const broken = brokenInviteInUrl(window);
const pending = captureInvite(window, storage);
const access = await resolveAccess({ baseUrl: config.baseUrl, storage });

// Con sesión, una invitación NUNCA se consume sola: se pregunta al API a qué espacio y rol lleva, y se pide confirmación (ADR 0019).
const check = await checkPendingInvite({ baseUrl: config.baseUrl, access, token: pending, storage });
const joined = takeJoined(session);

/** @type {import("./ui/account.js").Notice} */
let notice = null;
if (joined !== null) notice = { kind: "joined", name: joined.name, role: joined.role };
else if (check.state === "gone") notice = { kind: "invite_failed" };
else if (check.state === "unreachable") notice = { kind: "invite_unreachable" };
else if (check.state === "unavailable") notice = { kind: "invite_unavailable" };
else if (broken) notice = { kind: "invite_broken" };

const lang = (() => {
  try {
    return detectLang(window.localStorage.getItem("captionforge_lang"), window.navigator.languages);
  } catch {
    return detectLang(null, window.navigator.languages);
  }
})();

/** @type {ReturnType<typeof createAccount> | null} */
let account = null;
/** @type {ReturnType<typeof createInviteConfirm> | null} */
let confirm = null;
account = createAccount({ doc: document, win: window, baseUrl: config.baseUrl, access, t: createTranslator(lang), notice, pendingInvite: pending !== null });
if (check.state === "confirm") confirm = createInviteConfirm({ doc: document, win: window, baseUrl: config.baseUrl, token: check.token, preview: check.preview, storage, session, t: createTranslator(lang) });
createApp({
  doc: document,
  win: window,
  config,
  onTranslate: (t) => {
    account?.refresh(t);
    confirm?.refresh(t);
  },
});
