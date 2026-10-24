// Claves externas del espacio (ADR 0020): el Dueño guarda aquí la clave de OpenAI o ElevenLabs que usarán «Traducir» y «Doblar».
// Reglas de seguridad de esta pantalla:
//  - Solo existe con sesión, rol Dueño y BYOK activado en el servidor. En modo local (sin sesión) no se muestra ni se consulta nada.
//  - La clave nunca vuelve del servidor: de una guardada solo se pinta «…últimos 4». El campo siempre nace vacío, es un password
//    con autocomplete="off" y se vacía en cuanto se guarda; la clave no se copia a ningún texto, aviso ni atributo.
//  - Todo texto entra con textContent.

import { getCapabilities } from "../api/capabilities.js";
import { ApiError } from "../api/errors.js";
import { deleteExternalKey, listExternalKeys, saveExternalKey } from "../api/external-keys.js";

/**
 * @param {{
 *   doc: Document, baseUrl: string, access: import("../api/access.js").Access,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   announce?: (text: string) => void, fetchImpl?: typeof fetch, capabilities?: typeof getCapabilities,
 * }} deps
 */
export function createExternalKeys({ doc, baseUrl, access, t: initialT, announce = () => {}, fetchImpl, capabilities = getCapabilities }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = { toggle: $("account-extkeys-toggle"), panel: $("extkeys-panel"), list: $("extkeys-list"), problem: $("extkeys-problem") };

  let t = initialT;
  const eligible = access.mode === "session" && access.me?.role === "OWNER";
  /** @type {readonly string[]} */
  let providers = [];
  /** @type {Map<string, import("../api/external-keys.js").ExternalKeyView>} */
  let stored = new Map();
  let loaded = false;
  /** @type {string | null} */
  let problem = null;
  /** @type {string | null} */
  let confirming = null;
  /** Proveedores con un guardado en vuelo: un segundo clic no envía otra vez. @type {Set<string>} */
  const saving = new Set();
  /** Verdadero mientras la lista se reconstruye: los blur por quitar nodos no cuentan como salir del botón. */
  let rendering = false;
  /** Botones de la lista en pantalla, por `acción:proveedor`, para devolverles el foco tras repintar. @type {Map<string, any>} */
  const buttons = new Map();
  /** Campos en pantalla y lo escrito en ellos, para no perderlo cuando la lista se pinta de nuevo. @type {Map<string, any>} */
  const inputs = new Map();
  /** @type {Map<string, string>} */
  const drafts = new Map();
  const base = { baseUrl, fetchImpl };

  els.toggle.hidden = true;

  const providerName = (/** @type {string} */ provider) => t(`extkeys.provider.${provider}`);

  /** @param {unknown} error */
  function describe(error) {
    const code = error instanceof ApiError ? error.code : "network";
    return t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
  }

  /** @param {string} provider */
  function renderRow(provider) {
    const view = stored.get(provider);
    const item = doc.createElement("li");
    item.className = "keys__item extkeys__item";
    const name = doc.createElement("span");
    name.className = "keys__name";
    name.textContent = providerName(provider);
    const state = doc.createElement("span");
    state.className = "panel__detail keys__detail";
    state.setAttribute("id", `extkeys-state-${provider}`);
    state.textContent = view === undefined ? t("extkeys.none") : t("extkeys.saved", { last4: view.last4 });

    const field = doc.createElement("div");
    field.className = "field extkeys__field";
    const id = `extkeys-input-${provider}`;
    const label = doc.createElement("label");
    label.setAttribute("for", id);
    label.textContent = t("extkeys.field", { provider: providerName(provider) });
    const input = doc.createElement("input");
    input.setAttribute("id", id);
    input.setAttribute("type", "password");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("aria-describedby", `extkeys-state-${provider}`);
    // Los navegadores suelen ignorar autocomplete="off" en contraseñas; estas marcas piden a los gestores que no ofrezcan guardar la clave.
    input.setAttribute("data-lpignore", "true");
    input.setAttribute("data-1p-ignore", "true");
    input.setAttribute("data-field", "key");
    input.setAttribute("data-provider", provider);
    input.value = drafts.get(provider) ?? "";
    inputs.set(provider, input);
    field.append(label, input);

    const save = doc.createElement("button");
    save.type = "button";
    save.className = "btn btn--secondary";
    save.setAttribute("data-action", "save");
    save.setAttribute("data-provider", provider);
    save.setAttribute("aria-label", t(view === undefined ? "extkeys.saveFor" : "extkeys.replaceFor", { provider: providerName(provider) }));
    buttons.set(`save:${provider}`, save);
    save.textContent = view === undefined ? t("extkeys.save") : t("extkeys.replace");
    save.addEventListener("click", () => void saveKey(provider));
    item.append(name, state, field, save);

    if (view !== undefined) {
      const remove = doc.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--ghost";
      remove.setAttribute("data-action", "delete");
      remove.setAttribute("data-provider", provider);
      remove.setAttribute("aria-label", t(confirming === provider ? "extkeys.deleteConfirmFor" : "extkeys.deleteFor", { provider: providerName(provider) }));
      remove.textContent = confirming === provider ? t("extkeys.deleteConfirm") : t("extkeys.delete");
      remove.addEventListener("click", () => void removeKey(provider));
      // La confirmación no caduca sola (quien usa lector de pantalla o conmutador necesita tiempo): se cancela al salir del botón o con Esc.
      remove.addEventListener("blur", () => cancelConfirm(provider));
      remove.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
        if (event.key === "Escape") cancelConfirm(provider);
      });
      buttons.set(`delete:${provider}`, remove);
      item.append(remove);
    }
    return item;
  }

  /** @param {string} [focusKey] `acción:proveedor` del botón que debe quedarse con el foco (la lista se reconstruye entera) */
  function render(focusKey) {
    for (const [provider, input] of inputs) drafts.set(provider, input.value ?? "");
    inputs.clear();
    buttons.clear();
    rendering = true;
    try {
      els.list.replaceChildren(...providers.map(renderRow));
    } finally {
      rendering = false;
    }
    els.problem.textContent = problem ?? "";
    els.problem.hidden = problem === null;
    if (focusKey !== undefined) buttons.get(focusKey)?.focus();
  }

  /** @param {string} provider */
  function cancelConfirm(provider) {
    if (rendering || confirming !== provider) return;
    confirming = null;
    render();
  }

  async function load() {
    try {
      const keys = await listExternalKeys(base);
      stored = new Map(keys.map((key) => [key.provider, key]));
      loaded = true;
      problem = null;
    } catch (error) {
      problem = describe(error);
    }
    render();
  }

  /** @param {string} provider */
  async function saveKey(provider) {
    const input = inputs.get(provider);
    const key = String(input?.value ?? "").trim();
    if (key === "") {
      problem = t("extkeys.empty");
      return render(`save:${provider}`);
    }
    if (saving.has(provider)) return;
    saving.add(provider);
    try {
      await saveExternalKey({ ...base, provider, key });
    } catch (error) {
      problem = describe(error);
      els.problem.textContent = problem; // el campo se queda como estaba: se corrige sin volver a pegar
      els.problem.hidden = false;
      return;
    } finally {
      saving.delete(provider);
    }
    // El campo que importa es el vigente: la lista pudo repintarse mientras se guardaba (p. ej. un cambio de idioma).
    drafts.delete(provider);
    for (const field of [input, inputs.get(provider)]) if (field) field.value = "";
    announce(t("extkeys.savedAnnounce", { provider: providerName(provider) }));
    await load();
  }

  /** @param {string} provider */
  async function removeKey(provider) {
    if (confirming !== provider) {
      confirming = provider;
      render(`delete:${provider}`);
      announce(t("extkeys.deleteConfirm"));
      return;
    }
    confirming = null;
    try {
      await deleteExternalKey({ ...base, provider });
      announce(t("extkeys.deletedAnnounce", { provider: providerName(provider) }));
      await load();
    } catch (error) {
      problem = describe(error);
      render(`delete:${provider}`);
    }
  }

  els.toggle.addEventListener("click", () => {
    const open = els.panel.hidden;
    els.panel.hidden = !open;
    els.toggle.setAttribute("aria-expanded", String(open));
    if (open && !loaded) void load();
    if (!open) {
      // Al cerrar el panel no queda en memoria nada de lo que se estaba escribiendo.
      drafts.clear();
      confirming = null;
      render();
    }
  });

  if (eligible) {
    void capabilities({ baseUrl }).then(
      (found) => {
        if (!found.byok.enabled || found.byok.providers.length === 0) return;
        providers = found.byok.providers;
        els.toggle.hidden = false;
        render();
      },
      () => {}, // sin capacidades el panel simplemente no aparece
    );
  }

  return {
    /** @param {typeof initialT} next */
    refresh(next) {
      t = next;
      if (providers.length > 0) render();
    },
  };
}
