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
  /** Campos opcionales en pantalla (URL base, modelo), por `campo:proveedor`. @type {Map<string, any>} */
  const extraInputs = new Map();
  /** Campos opcionales que la persona modificó (aunque los haya dejado vacíos a propósito). @type {Set<string>} */
  const touched = new Set();
  const base = { baseUrl, fetchImpl };

  els.toggle.hidden = true;

  const providerName = (/** @type {string} */ provider) => t(`extkeys.provider.${provider}`);

  /** @param {unknown} error */
  function describe(error) {
    const code = error instanceof ApiError ? error.code : "network";
    return t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
  }

  /**
   * Campo de texto opcional de una fila (URL base, modelo). No es un secreto: no es de tipo password y el modelo guardado se ve.
   * @param {string} provider @param {"baseUrl" | "model"} name
   * @param {string} labelKey @param {string} placeholderKey @param {string} helpId @param {Record<string, string>} attributes
   */
  function optionalField(provider, name, labelKey, placeholderKey, helpId, attributes) {
    const wrapper = doc.createElement("div");
    wrapper.className = "field extkeys__field";
    const id = `extkeys-${name}-${provider}`;
    const label = doc.createElement("label");
    label.setAttribute("for", id);
    label.textContent = t(labelKey);
    const input = doc.createElement("input");
    input.setAttribute("id", id);
    input.setAttribute("type", "text");
    for (const [attribute, value] of Object.entries(attributes)) input.setAttribute(attribute, value);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("aria-describedby", helpId);
    input.setAttribute("placeholder", t(placeholderKey));
    input.setAttribute("data-field", name);
    input.setAttribute("data-provider", provider);
    // El modelo guardado se propone de nuevo (no es secreto); la URL no vuelve del servidor, así que se escribe otra vez.
    input.value = drafts.get(`${name}:${provider}`) ?? (name === "model" ? (stored.get(provider)?.model ?? "") : "");
    extraInputs.set(`${name}:${provider}`, input);
    input.addEventListener("input", () => touched.add(`${name}:${provider}`));
    wrapper.append(label, input);
    return wrapper;
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
    state.textContent = view === undefined ? t("extkeys.none") : [t("extkeys.saved", { last4: view.last4 }), ...(view.baseUrlHost ? [t("extkeys.server", { host: view.baseUrlHost })] : []), ...(view.model ? [t("extkeys.modelState", { model: view.model })] : [])].join(" · ");

    const customizable = provider === "openai"; // ADR 0022: solo OpenAI admite URL base y modelo propios
    const helpId = `extkeys-help-${provider}`;
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

    /** @type {any[]} */
    const extras = [];
    if (customizable) {
      extras.push(optionalField(provider, "baseUrl", "extkeys.baseUrl.label", "extkeys.baseUrl.placeholder", helpId, { inputmode: "url" }));
      extras.push(optionalField(provider, "model", "extkeys.model.label", "extkeys.model.placeholder", helpId, {}));
      const help = doc.createElement("p");
      help.className = "panel__detail extkeys__help";
      help.setAttribute("id", helpId);
      // La ayuda explica para qué sirve; si ya hay un servidor guardado, recuerda que al reemplazar la clave hay que volver a escribir la URL.
      help.textContent = [t("extkeys.openai.help"), ...(view?.baseUrlHost ? [t("extkeys.keepUrl", { host: view.baseUrlHost })] : [])].join(" ");
      extras.push(help);
    }

    const save = doc.createElement("button");
    save.type = "button";
    save.className = "btn btn--secondary";
    save.setAttribute("data-action", "save");
    save.setAttribute("data-provider", provider);
    save.setAttribute("aria-label", t(view === undefined ? "extkeys.saveFor" : "extkeys.replaceFor", { provider: providerName(provider) }));
    buttons.set(`save:${provider}`, save);
    save.textContent = view === undefined ? t("extkeys.save") : t("extkeys.replace");
    save.addEventListener("click", () => void saveKey(provider));
    item.append(name, state, field, ...extras, save);

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
    // Lo escrito en los campos opcionales se conserva al repintar. Un campo vacío que nadie tocó no cuenta como borrador: así el modelo
    // guardado puede proponerse en cuanto llega la lista.
    for (const [name, input] of extraInputs) {
      if ((input.value ?? "") !== "" || touched.has(name)) drafts.set(name, input.value ?? "");
      else drafts.delete(name);
    }
    inputs.clear();
    extraInputs.clear();
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
      await saveExternalKey({ ...base, provider, key, endpoint: String(extraInputs.get(`baseUrl:${provider}`)?.value ?? ""), model: String(extraInputs.get(`model:${provider}`)?.value ?? "") });
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
    drafts.delete(`baseUrl:${provider}`);
    drafts.delete(`model:${provider}`);
    for (const field of [input, inputs.get(provider), extraInputs.get(`baseUrl:${provider}`)]) if (field) field.value = "";
    // Los campos opcionales se sueltan: al repintar, la URL queda vacía y el modelo vuelve a ser el guardado (no el texto tecleado).
    extraInputs.delete(`baseUrl:${provider}`);
    extraInputs.delete(`model:${provider}`);
    touched.delete(`baseUrl:${provider}`);
    touched.delete(`model:${provider}`);
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
      touched.clear();
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
