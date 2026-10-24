import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createAi } from "../public/js/ui/ai.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const PARENT = "6f1d2c3e-1111-4222-8333-000000000001";
const TRANSLATION = "6f1d2c3e-1111-4222-8333-000000000002";
const DUBBING = "6f1d2c3e-1111-4222-8333-000000000003";

const PANEL = ["panel", "status", "bar", "bar-fill", "detail", "cancel", "reconnect", "open-parent"];
const TRANSLATE_IDS = ["translate-form", "translate-provider", "translate-target", "translate-estimate", "translate-hint", "translate-start", ...PANEL.map((id) => `translate-${id}`), "translate-dl-srt", "translate-dl-vtt"];
const DUB_IDS = ["dub-form", "dub-provider", "dub-voice", "dub-voice-hint", "dub-source", "dub-mix", "dub-estimate", "dub-hint", "dub-start", ...PANEL.map((id) => `dub-${id}`), "dub-dl-audio", "dub-dl-video", "dub-overflow"];

const ON = { diarization: { enabled: false }, byok: { enabled: true, providers: ["openai", "elevenlabs"] } };
const OFF = { diarization: { enabled: false }, byok: { enabled: false, providers: [] } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const ctx = (extra = {}) => ({ job: { id: PARENT, originalFilename: "charla.mp4" }, hasWords: false, dirty: false, characters: 12500, language: "es", ...extra });
const jobView = (kind, status, extra = {}) => ({ id: kind === "TRANSLATE" ? TRANSLATION : DUBBING, kind, status, stage: null, percent: status === "COMPLETED" ? 100 : 0, message: null, parentJobId: PARENT, originalFilename: "charla.mp4", ...extra });
const translateDone = (extra = {}) => jobView("TRANSLATE", "COMPLETED", { result: { provider: "openai", targetLanguage: "en", sourceLanguage: "es", artifacts: ["segments"] }, ...extra });
const dubDone = (extra = {}) => jobView("DUB", "COMPLETED", { result: { provider: "openai", mix: "replace", overflowSegments: [], artifacts: ["audio", "video"] }, ...extra });

const options = (select) => select.children.map((option) => option.value);

function setup({ capabilities = ON, context = ctx(), canLaunch = true, spendAnswer = true, feed = [], start = {}, cancel, aiConfig = { openai: null }, aiConfigError = null } = {}) {
  const elements = Object.fromEntries([...TRANSLATE_IDS, ...DUB_IDS].map((id) => [id, new FakeElement(id)]));
  for (const id of ["translate-form", "dub-form", "translate-panel", "dub-panel", "translate-dl-srt", "translate-dl-vtt", "dub-dl-audio", "dub-dl-video", "dub-overflow", "translate-cancel", "dub-cancel", "translate-reconnect", "dub-reconnect", "translate-open-parent", "dub-open-parent", "translate-hint", "dub-hint"]) elements[id].hidden = true;
  elements["translate-provider"].value = "argos";
  const doc = { documentElement: { lang: "es" }, activeElement: null, body: new FakeElement(), getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const state = { context, aiConfig, aiConfigCalls: 0, asked: [], followed: [], started: [], translateCalls: [], dubCalls: [], saved: [], cancelled: [], spendCancelled: 0, artifactCalls: [], feed, translated: [{ start: 0, end: 2, text: " Hello world" }, { start: 2, end: 4, text: "Second" }] };
  const spend = { ask: async (spendRequest) => (state.asked.push(spendRequest), spendAnswer), cancel: () => (state.spendCancelled += 1) };
  const follower = async ({ jobId, onJob }) => {
    state.followed.push(jobId);
    for (const view of state.feed) onJob(view);
  };
  const ai = createAi({
    doc,
    win: {},
    baseUrl: "",
    t,
    lang: () => "es",
    announce: () => {},
    context: () => state.context,
    canLaunch,
    capabilities: async () => capabilities,
    aiConfig: async () => {
      state.aiConfigCalls += 1;
      if (aiConfigError !== null) throw aiConfigError;
      return state.aiConfig;
    },
    spend,
    follower,
    onStarted: (job, parentName, kind) => state.started.push({ job, parentName, kind }),
    onOpenParent: (id) => state.started.push({ openParent: id }),
    startTranslate: async (args) => {
      state.translateCalls.push(args);
      if (start.translate instanceof Error) throw start.translate;
      return jobView("TRANSLATE", "QUEUED");
    },
    startDub: async (args) => {
      state.dubCalls.push(args);
      if (start.dub instanceof Error) throw start.dub;
      return jobView("DUB", "QUEUED");
    },
    cancel: cancel ?? (async ({ jobId }) => (state.cancelled.push(jobId), jobView("TRANSLATE", "CANCELLED"))),
    fetchArtifact: async ({ jobId, name }) => (
      state.artifactCalls.push({ jobId, name }),
      { blob: async () => new Blob([`bytes:${name}`]), json: async () => state.translated }
    ),
    save: async ({ blob, filename }) => state.saved.push({ filename, text: await blob.text() }),
  });
  return { ai, elements, state, el: (id) => elements[id] };
}

async function ready(options) {
  const made = setup(options);
  await flush();
  made.ai.refreshForm();
  return made;
}

describe("quién ve los formularios", () => {
  it("sin transcripción abierta están ocultos", async () => {
    const { el } = await ready({ context: null });
    assert.equal(el("translate-form").hidden, true);
    assert.equal(el("dub-form").hidden, true);
  });

  it("un Lector no los ve aunque haya transcripción", async () => {
    const { el } = await ready({ canLaunch: false });
    assert.equal(el("translate-form").hidden, true);
    assert.equal(el("dub-form").hidden, true);
  });

  it("con transcripción y permiso se ven", async () => {
    const { el } = await ready();
    assert.equal(el("translate-form").hidden, false);
    assert.equal(el("dub-form").hidden, false);
  });
});

describe("traducir: opciones y estimación", () => {
  it("sin BYOK (modo local) solo ofrece el motor local", async () => {
    const { el } = await ready({ capabilities: OFF });
    assert.deepEqual(options(el("translate-provider")), ["argos"]);
  });

  it("con BYOK ofrece también OpenAI", async () => {
    const { el } = await ready();
    assert.deepEqual(options(el("translate-provider")), ["argos", "openai"]);
  });

  it("el destino no incluye el idioma de origen y arranca en inglés (o español si el origen es inglés)", async () => {
    const spanish = await ready({ context: ctx({ language: "es" }) });
    assert.equal(options(spanish.el("translate-target")).includes("es"), false);
    assert.equal(spanish.el("translate-target").value, "en");
    const english = await ready({ context: ctx({ language: "en" }) });
    assert.equal(options(english.el("translate-target")).includes("en"), false);
    assert.equal(english.el("translate-target").value, "es");
  });

  it("el motor local dice que no cuesta; OpenAI muestra «≈ N caracteres» y el proveedor", async () => {
    const { el } = await ready();
    assert.match(el("translate-estimate").textContent, /sin costo/);
    el("translate-provider").value = "openai";
    el("translate-provider").fire("change");
    assert.match(el("translate-estimate").textContent, /≈\s*12[.\s ]?500 caracteres/);
    assert.match(el("translate-estimate").textContent, /OpenAI/);
  });
});

describe("traducir: lanzar el trabajo", () => {
  it("con el motor local no pide confirmación: lanza, sigue el trabajo y lo registra", async () => {
    const { el, state } = await ready({ feed: [jobView("TRANSLATE", "QUEUED")] });
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, []);
    assert.deepEqual(state.translateCalls, [{ baseUrl: "", jobId: PARENT, provider: "argos", targetLanguage: "en" }]);
    assert.deepEqual(state.started.map((entry) => [entry.job?.id, entry.parentName, entry.kind]), [[TRANSLATION, "charla.mp4", "TRANSLATE"]]);
    assert.deepEqual(state.followed, [TRANSLATION]);
    assert.equal(el("translate-panel").hidden, false);
    assert.match(el("translate-status").textContent, /En cola/);
  });

  it("con OpenAI pide confirmación con la estimación y no llama al API si se rechaza", async () => {
    const { el, state } = await ready({ spendAnswer: false });
    el("translate-provider").value = "openai";
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, [{ provider: "openai", characters: 12500 }]);
    assert.deepEqual(state.translateCalls, []);
    assert.equal(el("translate-panel").hidden, true);
    assert.equal(el("translate-start").disabled, false, "tras cancelar el botón vuelve a estar disponible");
  });

  it("con OpenAI y confirmación lanza con ese proveedor", async () => {
    const { el, state } = await ready({ spendAnswer: true });
    el("translate-provider").value = "openai";
    el("translate-target").value = "fr";
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(state.translateCalls.map((call) => [call.provider, call.targetLanguage]), [["openai", "fr"]]);
  });

  it("los errores del API salen traducidos y el formulario queda listo para reintentar", async () => {
    const cases = [
      ["external_key_missing", /Falta la clave del proveedor/],
      ["byok_disabled", /no tiene activadas/],
      ["job_too_large", /demasiado largo/],
      ["same_language", /ya están en ese idioma/],
      ["conflict", /Ya hay una traducción en curso/],
      ["network", /conexión|red|servidor/i],
    ];
    for (const [code, pattern] of cases) {
      const { el, state } = await ready({ start: { translate: new ApiError({ status: 409, code }) } });
      el("translate-form").fire("submit");
      await flush();
      assert.equal(el("translate-hint").hidden, false, code);
      assert.match(el("translate-hint").textContent, pattern, code);
      assert.equal(el("translate-start").disabled, false, code);
      assert.equal(state.followed.length, 0, code);
    }
  });

  it("con cambios sin guardar no se puede traducir y se explica", async () => {
    const { el } = await ready({ context: ctx({ dirty: true }) });
    assert.equal(el("translate-start").disabled, true);
    assert.match(el("translate-hint").textContent, /Guarda los cambios/);
  });
});

describe("traducir: seguimiento y descargas", () => {
  it("un trabajo en curso bloquea otro igual", async () => {
    const { el } = await ready({ feed: [jobView("TRANSLATE", "RUNNING", { stage: "translating", percent: 40 })] });
    el("translate-form").fire("submit");
    await flush();
    assert.equal(el("translate-start").disabled, true);
    assert.equal(el("translate-cancel").hidden, false);
    assert.match(el("translate-status").textContent, /Traduciendo/);
  });

  it("al terminar ofrece .srt y .vtt traducidos con el idioma en el nombre", async () => {
    const { el, state } = await ready({ feed: [translateDone()] });
    el("translate-form").fire("submit");
    await flush();
    assert.equal(el("translate-dl-srt").hidden, false);
    assert.equal(el("translate-dl-vtt").hidden, false);
    el("translate-dl-srt").fire("click");
    await flush();
    el("translate-dl-vtt").fire("click");
    await flush();
    // La traducción se lee de su artefacto: GET /segments es solo de las transcripciones (409 para una traducción).
    assert.deepEqual(state.artifactCalls, [{ jobId: TRANSLATION, name: "segments" }, { jobId: TRANSLATION, name: "segments" }]);
    assert.deepEqual(state.saved.map((file) => file.filename), ["charla.en.srt", "charla.en.vtt"]);
    assert.match(state.saved[0].text, /1\n00:00:00,000 --> 00:00:02,000\nHello world/);
    assert.match(state.saved[1].text, /^WEBVTT/);
  });

  it("cancelar llama al API con el trabajo de traducción", async () => {
    const { el, state } = await ready({ feed: [jobView("TRANSLATE", "RUNNING", { stage: "translating", percent: 10 })] });
    el("translate-form").fire("submit");
    await flush();
    el("translate-cancel").fire("click");
    await flush();
    assert.deepEqual(state.cancelled, [TRANSLATION]);
  });

  it("un fallo del proveedor muestra su texto en el idioma de la interfaz, no el genérico ni el del servidor", async () => {
    const failed = jobView("TRANSLATE", "FAILED", { error: { code: "EXTERNAL_QUOTA_EXCEEDED", message: "mensaje del servidor" } });
    const { el } = await ready({ feed: [failed] });
    el("translate-form").fire("submit");
    await flush();
    assert.match(el("translate-status").textContent, /saldo|límite/);
    assert.doesNotMatch(el("translate-status").textContent, /interno/);
    assert.equal(el("translate-detail").hidden, true);
  });
});

describe("traducir: descarga de una respuesta rota", () => {
  it("si el artefacto no tiene la forma de unos subtítulos lo dice y no entrega ningún archivo", async () => {
    const { el, state } = await ready({ feed: [translateDone()] });
    state.translated = { no: "es una lista" };
    el("translate-form").fire("submit");
    await flush();
    el("translate-dl-srt").fire("click");
    await flush();
    assert.deepEqual(state.saved, []);
    assert.equal(el("translate-hint").hidden, false);
    assert.match(el("translate-hint").textContent, /respuesta|servidor|inesperad/i);
  });
});

describe("doblar: opciones y bloqueos", () => {
  it("sin BYOK el formulario se ve pero no se puede enviar, y lo explica", async () => {
    const { el } = await ready({ capabilities: OFF });
    assert.equal(el("dub-form").hidden, false);
    assert.equal(el("dub-start").disabled, true);
    assert.match(el("dub-hint").textContent, /no las tiene activadas|modo local/);
    assert.deepEqual(options(el("dub-provider")), []);
  });

  it("sin BYOK sigue bloqueado aunque se escriba una voz, y enviar no llama al API", async () => {
    const { el, state } = await ready({ capabilities: OFF });
    el("dub-voice").value = "alloy";
    el("dub-voice").fire("input");
    assert.equal(el("dub-start").disabled, true);
    el("dub-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, []);
    assert.deepEqual(state.dubCalls, []);
  });

  it("con BYOK ofrece OpenAI y ElevenLabs, y la voz de OpenAI viene con un valor por defecto", async () => {
    const { el } = await ready();
    assert.deepEqual(options(el("dub-provider")), ["openai", "elevenlabs"]);
    assert.equal(el("dub-voice").value, "alloy");
    assert.equal(el("dub-start").disabled, false);
  });

  it("ElevenLabs pide el ID de la voz: sin voz no se puede enviar", async () => {
    const { el } = await ready();
    el("dub-provider").value = "elevenlabs";
    el("dub-provider").fire("change");
    assert.equal(el("dub-voice").value, "");
    assert.equal(el("dub-start").disabled, true);
    assert.match(el("dub-hint").textContent, /Escribe la voz/);
    assert.match(el("dub-voice-hint").textContent, /ElevenLabs/);
  });

  it("las tres salidas están disponibles y por defecto se mezcla en el video", async () => {
    const { el } = await ready();
    assert.deepEqual(options(el("dub-mix")), ["none", "replace", "duck"]);
    assert.equal(el("dub-mix").value, "replace");
  });
});

describe("doblar: lanzar el trabajo", () => {
  it("siempre pide confirmación con la estimación antes de llamar al API", async () => {
    const { el, state } = await ready({ spendAnswer: false });
    el("dub-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, [{ provider: "openai", characters: 12500 }]);
    assert.deepEqual(state.dubCalls, []);
    assert.equal(el("dub-start").disabled, false, "tras cancelar el botón vuelve a estar disponible");
  });

  it("mientras se espera la confirmación el botón sigue activo (el foco no se pierde) pero un segundo envío no hace nada", async () => {
    let answer;
    const gate = new Promise((resolve) => (answer = resolve));
    const { el, state } = await ready({ spendAnswer: gate });
    el("dub-form").fire("submit");
    await flush();
    assert.equal(el("dub-start").disabled, false);
    el("dub-form").fire("submit");
    await flush();
    assert.equal(state.asked.length, 1);
    answer(false);
    await flush();
  });

  it("la voz se puede vaciar mientras se escribe: no reaparece la de por defecto y se pide escribirla", async () => {
    const { el } = await ready();
    el("dub-voice").value = "";
    el("dub-voice").fire("input");
    assert.equal(el("dub-voice").value, "");
    assert.equal(el("dub-start").disabled, true);
    assert.match(el("dub-hint").textContent, /Escribe la voz/);
  });

  it("al cambiar de proveedor nunca se conserva la voz del otro", async () => {
    const { el } = await ready();
    el("dub-provider").value = "elevenlabs";
    el("dub-provider").fire("change");
    el("dub-voice").value = "EXAVITQu4vr4xnSDxMaL";
    el("dub-voice").fire("input");
    el("dub-provider").value = "openai";
    el("dub-provider").fire("change");
    assert.equal(el("dub-voice").value, "alloy");
    el("dub-voice").value = "nova";
    el("dub-provider").value = "elevenlabs";
    el("dub-provider").fire("change");
    assert.equal(el("dub-voice").value, "");
  });

  it("confirmado, manda proveedor, voz y mezcla, y sigue el trabajo", async () => {
    const { el, state } = await ready({ feed: [jobView("DUB", "QUEUED")] });
    el("dub-mix").value = "duck";
    el("dub-form").fire("submit");
    await flush();
    assert.deepEqual(state.dubCalls, [{ baseUrl: "", jobId: PARENT, provider: "openai", voice: "alloy", mix: "duck" }]);
    assert.deepEqual(state.followed, [DUBBING]);
    assert.equal(el("dub-panel").hidden, false);
    assert.deepEqual(state.started.map((entry) => entry.kind), ["DUB"]);
  });

  it("falta de clave y tope superado salen traducidos", async () => {
    for (const [code, pattern] of [["external_key_missing", /Falta la clave del proveedor/], ["job_too_large", /demasiado largo/]]) {
      const { el } = await ready({ start: { dub: new ApiError({ status: 409, code }) } });
      el("dub-form").fire("submit");
      await flush();
      assert.match(el("dub-hint").textContent, pattern, code);
      assert.equal(el("dub-start").disabled, false, code);
    }
  });

  it("tras terminar una traducción se puede doblar ESA traducción", async () => {
    const { el, state } = await ready({ feed: [translateDone()] });
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(options(el("dub-source")), ["", TRANSLATION]);
    assert.match(el("dub-source").children[1].textContent, /Traducción a/);
    state.feed = [];
    el("dub-source").value = TRANSLATION;
    el("dub-form").fire("submit");
    await flush();
    assert.equal(state.dubCalls[0].translationId, TRANSLATION);
  });

  it("al cambiar de transcripción las traducciones de la anterior dejan de ofrecerse", async () => {
    const { ai, el, state } = await ready({ feed: [translateDone()] });
    el("translate-form").fire("submit");
    await flush();
    state.context = ctx({ job: { id: "6f1d2c3e-1111-4222-8333-0000000000ff", originalFilename: "otra.mp4" } });
    ai.refreshForm();
    assert.deepEqual(options(el("dub-source")), [""]);
  });
});

describe("doblar: resultado", () => {
  it("con mezcla ofrece el audio y el video; el nombre lleva dub o dubbed", async () => {
    const { el, state } = await ready({ feed: [dubDone()] });
    el("dub-form").fire("submit");
    await flush();
    assert.equal(el("dub-dl-audio").hidden, false);
    assert.equal(el("dub-dl-video").hidden, false);
    el("dub-dl-audio").fire("click");
    await flush();
    el("dub-dl-video").fire("click");
    await flush();
    assert.deepEqual(state.artifactCalls, [{ jobId: DUBBING, name: "audio" }, { jobId: DUBBING, name: "video" }]);
    assert.deepEqual(state.saved.map((file) => file.filename), ["charla.dub.mp3", "charla.dubbed.mp4"]);
  });

  it("sin mezcla (solo audio) no hay botón de video", async () => {
    const { el } = await ready({ feed: [dubDone({ result: { provider: "openai", mix: "none", overflowSegments: [], artifacts: ["audio"] } })] });
    el("dub-form").fire("submit");
    await flush();
    assert.equal(el("dub-dl-audio").hidden, false);
    assert.equal(el("dub-dl-video").hidden, true);
  });

  it("avisa cuántas frases no cupieron en su tiempo", async () => {
    const { el } = await ready({ feed: [dubDone({ result: { provider: "openai", mix: "replace", overflowSegments: [3, 7, 9], artifacts: ["audio", "video"] } })] });
    el("dub-form").fire("submit");
    await flush();
    assert.equal(el("dub-overflow").hidden, false);
    assert.match(el("dub-overflow").textContent, /3 frases/);
  });

  it("sin desbordes no muestra el aviso", async () => {
    const { el } = await ready({ feed: [dubDone()] });
    el("dub-form").fire("submit");
    await flush();
    assert.equal(el("dub-overflow").hidden, true);
  });
});

describe("cambiar de transcripción", () => {
  it("detenerse cierra la confirmación de gasto que estuviera abierta", async () => {
    const { ai, state } = await ready();
    ai.stop();
    assert.equal(state.spendCancelled, 1);
  });
});

describe("abrir desde el historial", () => {
  it("adopt muestra un doblaje terminado con sus descargas y stop lo oculta", async () => {
    const { ai, el } = await ready();
    ai.adopt(dubDone());
    assert.equal(el("dub-panel").hidden, false);
    assert.equal(el("dub-dl-audio").hidden, false);
    assert.equal(el("dub-open-parent").hidden, false);
    ai.stop();
    assert.equal(el("dub-panel").hidden, true);
    assert.equal(el("translate-panel").hidden, true);
  });

  it("«Abrir los subtítulos originales» abre la transcripción de la que viene", async () => {
    const { ai, el, state } = await ready({ context: null });
    ai.adopt(translateDone());
    el("translate-open-parent").fire("click");
    assert.deepEqual(state.started, [{ openParent: PARENT }]);
  });
});

const DEEPSEEK = { openai: { model: "deepseek-chat", baseUrlHost: "api.deepseek.com" } };
const MODEL_ONLY = { openai: { model: "gpt-4.1-mini", baseUrlHost: null } };
const HOST_ONLY = { openai: { model: null, baseUrlHost: "api.groq.com" } };

describe("modelo y servidor propios en la estimación y en la confirmación de gasto (ADR 0022)", () => {
  it("sin configuración propia la estimación y la confirmación son las de siempre", async () => {
    const { el, state } = await ready({ aiConfig: { openai: null } });
    el("translate-provider").value = "openai";
    el("translate-provider").fire("change");
    assert.doesNotMatch(el("translate-estimate").textContent, /Modelo|Servidor/);
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, [{ provider: "openai", characters: 12500 }]);
  });

  it("con modelo y servidor propios la estimación los nombra y la confirmación los recibe", async () => {
    const { el, state } = await ready({ aiConfig: DEEPSEEK });
    el("translate-provider").value = "openai";
    el("translate-provider").fire("change");
    const estimate = el("translate-estimate").textContent;
    assert.match(estimate, /12[.\s\u00a0]?500 caracteres/);
    assert.match(estimate, /deepseek-chat/);
    assert.match(estimate, /api\.deepseek\.com/);
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, [{ provider: "openai", characters: 12500, model: "deepseek-chat", host: "api.deepseek.com" }]);
    assert.equal(state.translateCalls.length, 1);
  });

  it("solo el modelo, o solo el servidor, también se muestran", async () => {
    const onlyModel = await ready({ aiConfig: MODEL_ONLY });
    onlyModel.el("translate-provider").value = "openai";
    onlyModel.el("translate-provider").fire("change");
    assert.match(onlyModel.el("translate-estimate").textContent, /gpt-4\.1-mini/);
    assert.doesNotMatch(onlyModel.el("translate-estimate").textContent, /Servidor/);
    onlyModel.el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(onlyModel.state.asked, [{ provider: "openai", characters: 12500, model: "gpt-4.1-mini" }]);

    const onlyHost = await ready({ aiConfig: HOST_ONLY });
    onlyHost.el("translate-provider").value = "openai";
    onlyHost.el("translate-provider").fire("change");
    assert.match(onlyHost.el("translate-estimate").textContent, /api\.groq\.com/);
    onlyHost.el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(onlyHost.state.asked, [{ provider: "openai", characters: 12500, host: "api.groq.com" }]);
  });

  it("el motor local no muestra modelo ni servidor aunque estén configurados", async () => {
    const { el } = await ready({ aiConfig: DEEPSEEK });
    el("translate-provider").value = "argos";
    el("translate-provider").fire("change");
    assert.doesNotMatch(el("translate-estimate").textContent, /deepseek/);
  });

  it("doblar con OpenAI no menciona el modelo de traducción (la voz tiene el suyo)", async () => {
    const { el, state } = await ready({ aiConfig: DEEPSEEK });
    el("dub-provider").value = "openai";
    el("dub-voice").value = "alloy";
    el("dub-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked[0], { provider: "openai", characters: 12500 });
    assert.doesNotMatch(el("dub-estimate").textContent, /deepseek/);
  });

  it("si la configuración no se puede leer, todo sigue funcionando sin modelo", async () => {
    const { el, state } = await ready({ aiConfigError: new Error("sin red") });
    el("translate-provider").value = "openai";
    el("translate-provider").fire("change");
    assert.doesNotMatch(el("translate-estimate").textContent, /Modelo|Servidor/);
    el("translate-form").fire("submit");
    await flush();
    assert.deepEqual(state.asked, [{ provider: "openai", characters: 12500 }]);
  });

  it("sin BYOK no se consulta la configuración", async () => {
    const { state } = await ready({ capabilities: OFF });
    assert.equal(state.aiConfigCalls, 0);
  });

  it("refreshAiConfig vuelve a leerla tras guardar una clave y cambia la estimación", async () => {
    const made = await ready({ aiConfig: { openai: null } });
    made.state.aiConfig = DEEPSEEK;
    await made.ai.refreshAiConfig();
    made.el("translate-provider").value = "openai";
    made.el("translate-provider").fire("change");
    assert.match(made.el("translate-estimate").textContent, /deepseek-chat/);
  });
});
