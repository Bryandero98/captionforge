// Traducir y doblar (ADR 0020), dentro de la vista de resultados. Cada uno es un trabajo aparte con su propio panel (ui/ai-panel.js).
// Reglas de esta pantalla:
//  - Lo que manda texto a un proveedor externo (OpenAI, ElevenLabs) pide confirmación con la estimación «≈ N caracteres» ANTES de
//    llamar al API (ui/spend-confirm.js). El motor local (argos) no cuesta y no pregunta.
//  - Doblar solo funciona con claves externas: si el servidor no las tiene (modo local), el formulario se ve pero explica por qué no se puede.
//  - Los errores salen por su código estable, traducidos; nunca el texto del servidor ni el de un proveedor.
//  - Todo texto entra con textContent.

import { getAiConfig } from "../api/ai-config.js";
import { fetchArtifact as defaultFetchArtifact, saveBlobAs } from "../api/download.js";
import { ApiError } from "../api/errors.js";
import { cancelJob, startDub as defaultStartDub, startTranslate as defaultStartTranslate } from "../api/jobs.js";
import { followJob } from "../api/sse.js";
import { NO_CAPABILITIES } from "../api/capabilities.js";
import { formatCount } from "../domain/spend.js";
import { segmentsToSrtWithSpeakers } from "../domain/speakers.js";
import { segmentsToVtt } from "../domain/subtitles.js";
import { createAiPanel } from "./ai-panel.js";
import { languageNames } from "./language-names.js";
import { downloadName } from "./results.js";

const DUB_MIXES = /** @type {const} */ (["none", "replace", "duck"]);
const DEFAULT_MIX = "replace";
const OPENAI_DEFAULT_VOICE = "alloy";
const EXTERNAL_TRANSLATE = "openai";

/** Los subtítulos traducidos tal como los guarda el worker. Una forma rara es una respuesta que no es del API. @param {unknown} data @returns {{ start: number, end: number, text: string }[]} */
function translatedSegments(data) {
  const valid = (/** @type {any} */ item) => item !== null && typeof item === "object" && typeof item.text === "string" && Number.isFinite(item.start) && Number.isFinite(item.end);
  if (!Array.isArray(data) || !data.every(valid)) throw ApiError.local("bad_response");
  return data;
}

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   lang: () => string,
 *   announce: (text: string) => void,
 *   context: () => { job: import("../api/sse.js").JobView, hasWords?: boolean, dirty: boolean, characters: number, language: string | null } | null,
 *   canLaunch: boolean,
 *   capabilities: () => Promise<import("../api/capabilities.js").Capabilities>,
 *   spend: { ask: (spend: { provider: string, characters: number, model?: string, host?: string }) => Promise<boolean>, cancel?: () => void },
 *   aiConfig?: () => Promise<import("../api/ai-config.js").AiConfig>,
 *   onStarted: (job: import("../api/sse.js").JobView, parentName: string, kind: "TRANSLATE" | "DUB") => void,
 *   onOpenParent: (parentId: string) => void,
 *   follower?: typeof followJob, cancel?: typeof cancelJob,
 *   startTranslate?: typeof defaultStartTranslate, startDub?: typeof defaultStartDub,
 *   fetchArtifact?: typeof defaultFetchArtifact,
 *   save?: (file: { blob: Blob, filename: string }) => void | Promise<void>,
 * }} deps `t` es el traductor inicial; `refresh(next)` lo cambia
 */
export function createAi({
  doc, win, baseUrl, t: initialT, lang, announce, context, canLaunch, capabilities, spend, onStarted, onOpenParent,
  aiConfig = () => getAiConfig({ baseUrl }),
  follower = followJob, cancel = cancelJob, startTranslate = defaultStartTranslate, startDub = defaultStartDub,
  fetchArtifact = defaultFetchArtifact, save = (file) => saveBlobAs({ doc, win, ...file }),
}) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const tr = {
    form: $("translate-form"), provider: $("translate-provider"), target: $("translate-target"), estimate: $("translate-estimate"),
    hint: $("translate-hint"), submit: $("translate-start"), srt: $("translate-dl-srt"), vtt: $("translate-dl-vtt"),
  };
  const dub = {
    form: $("dub-form"), provider: $("dub-provider"), voice: $("dub-voice"), voiceHint: $("dub-voice-hint"), source: $("dub-source"), mix: $("dub-mix"),
    estimate: $("dub-estimate"), hint: $("dub-hint"), submit: $("dub-start"), audio: $("dub-dl-audio"), video: $("dub-dl-video"), overflow: $("dub-overflow"),
  };

  let t = initialT;
  let caps = NO_CAPABILITIES;
  /** Servidor y modelo propios de la clave de OpenAI del espacio (ADR 0022), o null si usa los de siempre. @type {import("../api/ai-config.js").OpenAiConfig | null} */
  let customAi = null;
  /** Traducciones terminadas en esta sesión, por transcripción: se pueden doblar en lugar del original. @type {Map<string, { id: string, language: string }>} */
  const translations = new Map();
  /** @type {string | null} */
  let translateProblem = null;
  /** @type {string | null} */
  let dubProblem = null;
  let startingTranslate = false;
  let startingDub = false;
  /** La voz de OpenAI se propone una sola vez: si la persona la borra para escribir otra, no reaparece. */
  let voiceSeeded = false;
  let epoch = 0;

  const translatePanel = createAiPanel({ doc, prefix: "translate", baseUrl, t: () => t, announce, onOpenParent, follower, cancel, onChange: () => onTranslateChange() });
  const dubPanel = createAiPanel({ doc, prefix: "dub", baseUrl, t: () => t, announce, onOpenParent, follower, cancel, onChange: () => onDubChange() });

  /** @param {unknown} error @param {string} conflictKey */
  function describe(error, conflictKey) {
    const code = error instanceof ApiError ? error.code : "network";
    if (code === "conflict") return t(conflictKey);
    return t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
  }

  /** Rellena un <select> conservando lo elegido; si ya no existe, usa `preferred` y si tampoco, la primera opción. @param {any} select @param {{ value: string, label: string }[]} choices @param {string} [preferred] */
  function fill(select, choices, preferred) {
    const keep = select.value;
    const has = (/** @type {string | undefined} */ value) => choices.some((choice) => choice.value === value);
    select.replaceChildren(...choices.map(({ value, label }) => Object.assign(doc.createElement("option"), { value, textContent: label })));
    select.value = has(keep) ? keep : has(preferred) ? preferred : (choices[0]?.value ?? "");
  }

  const translateProviders = () => ["argos", ...(caps.byok.enabled && caps.byok.providers.includes(EXTERNAL_TRANSLATE) ? [EXTERNAL_TRANSLATE] : [])];
  const dubProviders = () => (caps.byok.enabled ? caps.byok.providers.filter((provider) => provider === "openai" || provider === "elevenlabs") : []);
  const providerName = (/** @type {string} */ provider) => t(`extkeys.provider.${provider}`);

  function fillTranslate(/** @type {NonNullable<ReturnType<typeof context>>} */ ctx) {
    fill(tr.provider, translateProviders().map((value) => ({ value, label: t(`translate.provider.${value}`) })));
    const choices = languageNames(lang()).filter(({ code }) => code !== ctx.language).map(({ code, label }) => ({ value: code, label }));
    fill(tr.target, choices, ctx.language === "en" ? "es" : "en");
  }

  function fillDub(/** @type {NonNullable<ReturnType<typeof context>>} */ ctx) {
    fill(dub.provider, dubProviders().map((value) => ({ value, label: providerName(value) })));
    fill(dub.mix, DUB_MIXES.map((value) => ({ value, label: t(`dub.mix.${value}`) })), DEFAULT_MIX);
    const translation = translations.get(ctx.job.id);
    const languageLabel = translation === undefined ? "" : (languageNames(lang()).find(({ code }) => code === translation.language)?.label ?? translation.language);
    fill(dub.source, [{ value: "", label: t("dub.source.original") }, ...(translation === undefined ? [] : [{ value: translation.id, label: t("dub.source.translation", { language: languageLabel }) }])]);
    // La voz por defecto de OpenAI se propone sola; la de ElevenLabs es un ID de la cuenta de la persona y no tiene valor razonable.
    if (!voiceSeeded && dub.provider.value === "openai") {
      voiceSeeded = true;
      if (dub.voice.value === "") dub.voice.value = OPENAI_DEFAULT_VOICE;
    }
  }

  function refreshForm() {
    const ctx = context();
    const visible = ctx !== null && canLaunch;
    tr.form.hidden = !visible;
    dub.form.hidden = !visible;
    if (!visible || ctx === null) {
      onTranslateChange();
      onDubChange();
      return;
    }
    fillTranslate(ctx);
    fillDub(ctx);
    refreshTranslateState(ctx);
    refreshDubState(ctx);
    onTranslateChange();
    onDubChange();
  }

  /** Frases con el servidor y el modelo propios, para la estimación y la confirmación (vacío si usa los de siempre). */
  function customParts() {
    return [...(customAi?.baseUrlHost ? [t("spend.custom.host", { host: customAi.baseUrlHost })] : []), ...(customAi?.model ? [t("spend.custom.model", { model: customAi.model })] : [])];
  }

  function customSpend() {
    return { ...(customAi?.model ? { model: customAi.model } : {}), ...(customAi?.baseUrlHost ? { host: customAi.baseUrlHost } : {}) };
  }

  /** Vuelve a leer la configuración de IA del espacio. Si no se puede leer, se sigue sin modelo ni servidor propios. */
  async function refreshAiConfig() {
    try {
      customAi = (await aiConfig()).openai;
    } catch {
      customAi = null;
    }
    const ctx = context();
    if (ctx !== null) refreshTranslateState(ctx);
  }

  function refreshTranslateState(/** @type {NonNullable<ReturnType<typeof context>>} */ ctx) {
    const external = tr.provider.value === EXTERNAL_TRANSLATE;
    tr.estimate.textContent = external
      ? [t("translate.estimate.external", { characters: formatCount(ctx.characters, lang()), provider: providerName(tr.provider.value) }), ...customParts()].join(" ")
      : t("translate.estimate.local");
    const blocked = ctx.dirty ? t("translate.hint.dirty") : translatePanel.busy() ? t("translate.hint.busy") : translateProblem;
    tr.hint.textContent = blocked ?? "";
    tr.hint.hidden = blocked === null;
    tr.submit.disabled = ctx.dirty || translatePanel.busy() || startingTranslate || tr.target.value === "";
  }

  function refreshDubState(/** @type {NonNullable<ReturnType<typeof context>>} */ ctx) {
    const providers = dubProviders();
    const provider = dub.provider.value;
    dub.estimate.textContent = providers.length === 0 ? "" : t("dub.estimate", { characters: formatCount(ctx.characters, lang()), provider: providerName(provider) });
    dub.voiceHint.textContent = providers.length === 0 ? "" : t(`dub.voice.hint.${provider}`);
    const noVoice = dub.voice.value.trim() === "";
    const blocked = providers.length === 0 ? t("dub.hint.byokOff") : ctx.dirty ? t("dub.hint.dirty") : dubPanel.busy() ? t("dub.hint.busy") : dubProblem ?? (noVoice ? t("dub.hint.voice") : null);
    dub.hint.textContent = blocked ?? "";
    dub.hint.hidden = blocked === null;
    dub.submit.disabled = providers.length === 0 || ctx.dirty || dubPanel.busy() || startingDub || noVoice;
  }

  /** Lo que depende del trabajo terminado: descargas y la traducción que se podrá doblar. */
  function onTranslateChange() {
    const view = translatePanel.view;
    const job = translatePanel.state.job;
    const done = view.kind === "completed" && job !== null;
    tr.srt.hidden = !done;
    tr.vtt.hidden = !done;
    if (done) {
      const language = /** @type {{ targetLanguage?: unknown } | null} */ (job.result ?? null)?.targetLanguage;
      const parentId = typeof job.parentJobId === "string" ? job.parentJobId : context()?.job.id;
      if (typeof language === "string" && typeof parentId === "string" && translations.get(parentId)?.id !== job.id) {
        translations.set(parentId, { id: job.id, language });
        refreshForm();
        return;
      }
    }
    const ctx = context();
    if (ctx !== null && canLaunch) refreshTranslateState(ctx);
  }

  function onDubChange() {
    const view = dubPanel.view;
    const job = dubPanel.state.job;
    const done = view.kind === "completed" && job !== null;
    const result = /** @type {{ artifacts?: unknown, overflowSegments?: unknown } | null} */ (job?.result ?? null);
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
    dub.audio.hidden = !(done && artifacts.includes("audio"));
    dub.video.hidden = !(done && artifacts.includes("video"));
    const overflow = done && Array.isArray(result?.overflowSegments) ? result.overflowSegments.length : 0;
    dub.overflow.hidden = overflow === 0;
    dub.overflow.textContent = overflow === 0 ? "" : t("dub.overflow", { count: overflow });
    const ctx = context();
    if (ctx !== null && canLaunch) refreshDubState(ctx);
  }

  /** @param {unknown} error @param {"translate" | "dub"} kind */
  function fail(error, kind) {
    if (!(error instanceof ApiError)) console.error(error);
    const message = describe(error, `${kind}.error.conflict`);
    if (kind === "translate") translateProblem = message;
    else dubProblem = message;
    announce(message);
  }

  async function submitTranslate() {
    const ctx = context();
    if (ctx === null || ctx.dirty || translatePanel.busy() || startingTranslate) return;
    const mine = epoch;
    const provider = tr.provider.value;
    const parentName = String(ctx.job.originalFilename ?? ctx.job.id);
    // Mientras se espera la confirmación el botón sigue activo (si no, el foco se perdería al cerrar el diálogo): `startingTranslate` ya frena un segundo envío.
    startingTranslate = true;
    translateProblem = null;
    /** @type {import("../api/sse.js").JobView | null} */
    let job = null;
    try {
      if (provider === EXTERNAL_TRANSLATE) {
        await refreshAiConfig(); // lo vigente en este momento: la clave pudo cambiar desde que se abrió la página
        if (mine !== epoch) return;
        if (!(await spend.ask({ provider, characters: ctx.characters, ...customSpend() }))) return;
      }
      if (mine !== epoch) return;
      refreshTranslateState(ctx);
      job = await startTranslate({ baseUrl, jobId: ctx.job.id, provider: /** @type {"argos" | "openai"} */ (provider), targetLanguage: tr.target.value });
    } catch (error) {
      if (mine !== epoch) return;
      fail(error, "translate");
    } finally {
      if (mine === epoch) {
        startingTranslate = false;
        if (job === null) refreshForm(); // rechazado, cancelado o fallido: el botón vuelve a estar disponible
      }
    }
    if (job !== null) {
      try {
        onStarted(job, parentName, "TRANSLATE");
        if (mine === epoch) {
          void translatePanel.follow(job.id);
          translatePanel.focus();
        }
      } catch (error) {
        console.error(error);
      }
    }
    if (mine === epoch) refreshForm();
  }

  async function submitDub() {
    const ctx = context();
    if (ctx === null || ctx.dirty || dubPanel.busy() || startingDub || dubProviders().length === 0) return;
    const voice = dub.voice.value.trim();
    if (voice === "") return;
    const mine = epoch;
    const provider = /** @type {"openai" | "elevenlabs"} */ (dub.provider.value);
    const parentName = String(ctx.job.originalFilename ?? ctx.job.id);
    startingDub = true;
    dubProblem = null;
    /** @type {import("../api/sse.js").JobView | null} */
    let job = null;
    try {
      if (!(await spend.ask({ provider, characters: ctx.characters }))) return;
      if (mine !== epoch) return;
      refreshDubState(ctx);
      const translationId = dub.source.value === "" ? undefined : dub.source.value;
      job = await startDub({ baseUrl, jobId: ctx.job.id, provider, voice, mix: /** @type {"none" | "replace" | "duck"} */ (dub.mix.value), ...(translationId === undefined ? {} : { translationId }) });
    } catch (error) {
      if (mine !== epoch) return;
      fail(error, "dub");
    } finally {
      if (mine === epoch) {
        startingDub = false;
        if (job === null) refreshForm();
      }
    }
    if (job !== null) {
      try {
        onStarted(job, parentName, "DUB");
        if (mine === epoch) {
          void dubPanel.follow(job.id);
          dubPanel.focus();
        }
      } catch (error) {
        console.error(error);
      }
    }
    if (mine === epoch) refreshForm();
  }

  /** Entrega un archivo; un fallo se muestra en la pista del formulario correspondiente. @param {"translate" | "dub"} kind @param {() => Promise<void>} action */
  async function deliver(kind, action) {
    try {
      await action();
    } catch (error) {
      fail(error, kind);
      refreshForm();
    }
  }

  /** @param {"srt" | "vtt"} format */
  function downloadTranslation(format) {
    const job = translatePanel.state.job;
    if (job === null) return;
    void deliver("translate", async () => {
      // GET /segments es solo de las transcripciones: la traducción se lee de su propio artefacto (una lista de subtítulos).
      const segments = translatedSegments(await (await fetchArtifact({ baseUrl, jobId: job.id, name: "segments" })).json());
      const language = /** @type {{ targetLanguage?: unknown } | null} */ (job.result ?? null)?.targetLanguage;
      const original = typeof job.originalFilename === "string" ? job.originalFilename : "";
      const filename = downloadName(original, `${typeof language === "string" ? language : "translated"}.${format}`);
      const text = format === "srt" ? segmentsToSrtWithSpeakers(segments, () => null) : segmentsToVtt(segments);
      await save({ blob: new Blob([text], { type: format === "srt" ? "application/x-subrip" : "text/vtt" }), filename });
    });
  }

  /** @param {"audio" | "video"} name */
  function downloadDub(name) {
    const job = dubPanel.state.job;
    if (job === null) return;
    void deliver("dub", async () => {
      const response = await fetchArtifact({ baseUrl, jobId: job.id, name });
      const original = typeof job.originalFilename === "string" ? job.originalFilename : "";
      await save({ blob: await response.blob(), filename: downloadName(original, name === "audio" ? "dub.mp3" : "dubbed.mp4") });
    });
  }

  tr.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void submitTranslate();
  });
  dub.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void submitDub();
  });
  for (const select of [tr.provider, tr.target]) select.addEventListener("change", () => refreshForm());
  // Al elegir el motor externo se vuelve a leer qué servidor y modelo tiene la clave: pudo cambiarse desde el panel de claves.
  tr.provider.addEventListener("change", () => {
    if (tr.provider.value === EXTERNAL_TRANSLATE) void refreshAiConfig();
  });
  dub.provider.addEventListener("change", () => {
    // La voz de un proveedor no sirve para el otro: se propone la de OpenAI o se deja vacía para pegar el ID de ElevenLabs.
    dub.voice.value = dub.provider.value === "openai" ? OPENAI_DEFAULT_VOICE : "";
    refreshForm();
  });
  dub.voice.addEventListener("input", () => {
    // Solo se repinta el estado: reconstruir los <select> en cada tecla no aporta nada.
    const ctx = context();
    if (ctx !== null && canLaunch) refreshDubState(ctx);
  });
  tr.srt.addEventListener("click", (/** @type {Event} */ event) => {
    event.preventDefault();
    downloadTranslation("srt");
  });
  tr.vtt.addEventListener("click", (/** @type {Event} */ event) => {
    event.preventDefault();
    downloadTranslation("vtt");
  });
  dub.audio.addEventListener("click", (/** @type {Event} */ event) => {
    event.preventDefault();
    downloadDub("audio");
  });
  dub.video.addEventListener("click", (/** @type {Event} */ event) => {
    event.preventDefault();
    downloadDub("video");
  });

  void capabilities().then(
    (found) => {
      caps = found;
      refreshForm();
      if (found.byok.enabled) void refreshAiConfig();
    },
    () => {},
  );
  translatePanel.render();
  dubPanel.render();
  refreshForm();

  return {
    refreshForm,
    refreshAiConfig,
    /** Repinta los textos que dependen del idioma. @param {typeof initialT} [next] */
    refresh(next) {
      if (next !== undefined) t = next;
      refreshForm();
      translatePanel.render();
      dubPanel.render();
    },
    /** Muestra un trabajo de traducción o doblaje ya existente (abierto desde el historial). @param {import("../api/sse.js").JobView} job */
    adopt(job) {
      if (job.kind === "DUB") dubPanel.adopt(job);
      else translatePanel.adopt(job);
    },
    /** Deja de seguir y oculta los paneles. */
    stop() {
      epoch++;
      startingTranslate = false;
      startingDub = false;
      translateProblem = null;
      dubProblem = null;
      spend.cancel?.(); // un diálogo abierto de otra transcripción no debe quedar esperando
      translatePanel.stop();
      dubPanel.stop();
    },
  };
}
