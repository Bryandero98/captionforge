// Cuenta (ADR 0016): pantalla de entrada con GitHub y Google, barra con quien inició sesión y panel de claves de API.
// Todo texto entra con textContent. Los textos fijos los traduce app.js (data-i18n); aquí solo lo que cambia con los datos.

import { createKey, listKeys, logout, revokeKey } from "../api/account.js";
import { ApiError } from "../api/errors.js";

const LOGIN_ERRORS = new Set(["denied", "state", "provider", "unavailable"]);

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string, access: import("../api/access.js").Access,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   announce?: (text: string) => void,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createAccount({ doc, win, baseUrl, access, t: initialT, announce = () => {}, fetchImpl }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    content: $("app-content"),
    login: $("login-panel"),
    loginError: $("login-error"),
    github: $("login-github"),
    google: $("login-google"),
    none: $("login-none"),
    bar: $("account-bar"),
    name: $("account-name"),
    toggle: $("account-keys-toggle"),
    signOut: $("account-signout"),
    keys: $("keys-panel"),
    list: $("keys-list"),
    empty: $("keys-empty"),
    form: $("keys-form"),
    nameInput: $("keys-name"),
    problem: $("keys-problem"),
    created: $("keys-created"),
    createdValue: $("keys-created-value"),
    copy: $("keys-copy"),
  };

  let t = initialT;
  /** @type {import("../api/account.js").ApiKeyView[]} */
  let keys = [];
  let keysLoaded = false;
  /** @type {string | null} */
  let problem = null;
  let copied = false;
  const loginError = readLoginError(win);

  const signedIn = access.mode === "session";
  els.content.hidden = !(access.mode === "key" || signedIn);
  els.login.hidden = !(access.mode === "login" || access.mode === "none" || access.mode === "error");
  els.bar.hidden = !signedIn;
  for (const [name, link] of /** @type {const} */ ([["github", els.github], ["google", els.google]])) {
    link.hidden = !access.providers.includes(name);
    link.setAttribute("href", `${baseUrl.replace(/\/+$/, "")}/auth/${name}/start`);
  }

  function dateText(/** @type {string | null} */ iso) {
    if (iso === null) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(doc.documentElement.lang || "es", { year: "numeric", month: "short", day: "numeric" });
  }

  function renderLogin() {
    const message = access.mode === "none" ? null : access.mode === "error" ? t("login.error.unavailable") : loginError === null ? null : t(`login.error.${loginError}`);
    els.loginError.textContent = message ?? "";
    els.loginError.hidden = message === null;
    els.none.hidden = access.mode !== "none";
  }

  function renderKeys() {
    els.list.replaceChildren(
      ...keys.map((key) => {
        const item = doc.createElement("li");
        item.className = "keys__item";
        const label = doc.createElement("span");
        label.className = "keys__name";
        label.textContent = key.name;
        const detail = doc.createElement("span");
        detail.className = "panel__detail keys__detail";
        const used = dateText(key.lastUsedAt);
        detail.textContent = `${key.prefix}… · ${key.revokedAt === null ? (used === null ? t("keys.never") : t("keys.lastUsed", { date: used })) : t("keys.revoked")}`;
        item.append(label, detail);
        if (key.revokedAt === null) {
          const button = doc.createElement("button");
          button.type = "button";
          button.className = "btn btn--ghost";
          button.textContent = t("keys.revoke");
          button.setAttribute("aria-label", t("keys.revokeFor", { name: key.name }));
          button.addEventListener("click", () => void revoke(key));
          item.append(button);
        } else {
          item.classList.add("is-revoked");
        }
        return item;
      }),
    );
    els.empty.hidden = !keysLoaded || keys.length > 0;
    els.problem.textContent = problem ?? "";
    els.problem.hidden = problem === null;
    els.copy.textContent = copied ? t("keys.copied") : t("keys.copy");
  }

  function render() {
    if (signedIn) {
      const me = access.me;
      els.name.textContent = t("account.signedIn", { name: me?.user?.name ?? me?.user?.email ?? me?.tenant.name ?? "" });
      renderKeys();
    } else {
      renderLogin();
    }
  }

  /** @param {unknown} error */
  function describe(error) {
    const code = error instanceof ApiError ? error.code : "network";
    return code === "conflict" ? t("keys.error.limit") : t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
  }

  async function load() {
    try {
      keys = await listKeys({ baseUrl, fetchImpl });
      keysLoaded = true;
      problem = null;
    } catch (error) {
      problem = describe(error);
    }
    renderKeys();
  }

  /** @param {import("../api/account.js").ApiKeyView} key */
  async function revoke(key) {
    try {
      await revokeKey({ baseUrl, id: key.id, fetchImpl });
      announce(t("keys.revokedAnnounce", { name: key.name }));
      await load();
    } catch (error) {
      problem = describe(error);
      renderKeys();
    }
  }

  els.toggle.addEventListener("click", () => {
    const open = els.keys.hidden;
    els.keys.hidden = !open;
    els.toggle.setAttribute("aria-expanded", String(open));
    if (open && !keysLoaded) void load();
  });

  els.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void (async () => {
      const name = els.nameInput.value.trim();
      if (name === "") return;
      try {
        const created = await createKey({ baseUrl, name, fetchImpl });
        els.createdValue.textContent = created.key; // se ve UNA vez: el servidor ya solo guarda su hash
        els.created.hidden = false;
        copied = false;
        els.nameInput.value = "";
        announce(t("keys.createdAnnounce"));
        await load();
      } catch (error) {
        problem = describe(error);
        renderKeys();
      }
    })();
  });

  els.copy.addEventListener("click", () => {
    void (async () => {
      try {
        await win.navigator.clipboard.writeText(els.createdValue.textContent ?? "");
        copied = true;
      } catch {
        // sin permiso del portapapeles: se selecciona el texto para copiarlo a mano
        win.getSelection()?.selectAllChildren(els.createdValue);
      }
      renderKeys();
    })();
  });

  els.signOut.addEventListener("click", () => {
    void logout({ baseUrl, fetchImpl })
      .catch(() => {})
      .then(() => win.location.reload());
  });

  render();
  return {
    /** Repinta los textos que dependen de los datos tras un cambio de idioma. @param {typeof initialT} next */
    refresh(next) {
      t = next;
      render();
    },
  };
}

/** `?login_error=<código>` que deja el API al volver de un inicio de sesión fallido; solo códigos conocidos. @param {Window} win */
function readLoginError(win) {
  try {
    const code = new URLSearchParams(win.location.search).get("login_error");
    return code !== null && LOGIN_ERRORS.has(code) ? code : null;
  } catch {
    return null;
  }
}
