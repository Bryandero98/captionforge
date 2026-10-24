import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { createTranslator } from "../public/js/i18n/index.js";
import { createQuality } from "../public/js/ui/quality.js";
import { FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");
const JOB = "6f1d2c3e-1111-4222-8333-000000000001";
const OTHER_JOB = "6f1d2c3e-1111-4222-8333-000000000002";
const IDS = [
  "quality-panel", "quality-profile", "quality-profile-note", "quality-check", "quality-fix", "quality-hint", "quality-status", "quality-summary", "quality-issues",
  "quality-proposal", "quality-proposal-summary", "quality-proposal-changes", "quality-proposal-unfixable", "quality-apply", "quality-discard",
];
const PROFILES = [
  { id: "netflix", label: "Netflix (inglés)", verification: "verified", reference: "…" },
  { id: "netflix-es", label: "Netflix (español)", verification: "verified", reference: "…" },
  { id: "bbc", label: "BBC", verification: "unverified", reference: "…" },
  { id: "accessible", label: "Accesible", verification: "partial", reference: "…" },
  { id: "shorts", label: "Cortos", verification: "own-criteria", reference: "…" },
];
const summary = (extra = {}) => ({ segments: 10, errors: 2, warnings: 3, infos: 0, score: 50, ...extra });
const issue = (extra = {}) => ({ segment: 0, rule: "cps", severity: "warning", measured: 21.5, limit: 20, ...extra });
const REPORT = { profile: "netflix-es", etag: "e1", summary: summary(), issues: [issue({ segment: 2 }), issue({ segment: 4, rule: "cpl", severity: "error", measured: 50, limit: 42, line: 2 })] };
const FIX = {
  profile: "netflix-es",
  etag: "e1",
  edits: [{ index: 4, text: "uno\ndos" }, { index: 2, start: 0, end: 3.2 }],
  changes: [
    { segment: 4, kind: "line_break", before: { start: 0, end: 4, text: "uno dos" }, after: { start: 0, end: 4, text: "uno\ndos" } },
    { segment: 2, kind: "timing", before: { start: 0, end: 2, text: "x" }, after: { start: 0, end: 3.2, text: "x" } },
  ],
  unfixable: [issue({ segment: 7, rule: "cps" })],
  before: summary(),
  after: summary({ errors: 1, warnings: 2, score: 70 }),
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const texts = (node, out = []) => {
  out.push(node.textContent);
  for (const child of node.children ?? []) texts(child, out);
  return out;
};

function setup({ context = { job: { id: JOB }, dirty: false, language: "es" }, canEdit = true, report = REPORT, fix = FIX, reportError, fixError, applyError, profilesError } = {}) {
  const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  for (const id of ["quality-panel", "quality-fix", "quality-proposal", "quality-hint"]) elements[id].hidden = true;
  const doc = { documentElement: { lang: "es" }, getElementById: (id) => elements[id] ?? null, createElement: () => new FakeElement() };
  const state = { context, reportCalls: [], fixCalls: [], applied: [], onApplied: 0, announced: [], profilesCalls: 0, report };
  const quality = createQuality({
    doc,
    t,
    lang: () => "es",
    announce: (text) => state.announced.push(text),
    context: () => state.context,
    canEdit,
    fetchProfiles: async () => {
      state.profilesCalls += 1;
      if (profilesError) throw profilesError;
      return PROFILES;
    },
    fetchReport: async (args) => {
      state.reportCalls.push(args);
      if (reportError) throw reportError;
      return state.report;
    },
    fetchFix: async (args) => {
      state.fixCalls.push(args);
      if (fixError) throw fixError;
      return fix;
    },
    applyEdits: async (args) => {
      state.applied.push(args);
      if (applyError) throw applyError;
      return { segments: [], etag: "e2" };
    },
    onApplied: async () => {
      state.onApplied += 1;
    },
  });
  return { quality, state, el: (id) => elements[id], elements };
}

async function ready(options) {
  const made = setup(options);
  made.quality.refreshForm();
  await flush();
  return made;
}
const options = (select) => select.children.map((option) => option.value);

describe("quién ve el panel", () => {
  it("sin transcripción abierta está oculto", async () => {
    const { el } = await ready({ context: null });
    assert.equal(el("quality-panel").hidden, true);
  });

  it("con transcripción se ve, también para quien solo puede leer", async () => {
    const { el } = await ready({ canEdit: false });
    assert.equal(el("quality-panel").hidden, false);
    assert.equal(el("quality-check").disabled, false);
  });

  it("con cambios sin guardar en el editor no deja revisar y explica por qué", async () => {
    const { el } = await ready({ context: { job: { id: JOB }, dirty: true, language: "es" } });
    assert.equal(el("quality-check").disabled, true);
    assert.equal(el("quality-hint").hidden, false);
    assert.equal(el("quality-hint").textContent, t("quality.dirty"));
  });
});

describe("normas", () => {
  it("lista las normas del servidor con nombres traducidos y elige la del idioma del video", async () => {
    const { el } = await ready();
    assert.deepEqual(options(el("quality-profile")), ["netflix", "netflix-es", "bbc", "accessible", "shorts"]);
    assert.equal(el("quality-profile").children[0].textContent, t("quality.profileName.netflix"));
    assert.equal(el("quality-profile").value, "netflix-es");
  });

  it("para un video que no es español propone Netflix (inglés)", async () => {
    const { el } = await ready({ context: { job: { id: JOB }, dirty: false, language: "en" } });
    assert.equal(el("quality-profile").value, "netflix");
  });

  it("dice cuánto se verificó la norma elegida", async () => {
    const { el } = await ready();
    el("quality-profile").value = "bbc";
    el("quality-profile").fire("change");
    assert.equal(el("quality-profile-note").textContent, t("quality.verification.unverified"));
  });

  it("las normas se piden una sola vez", async () => {
    const { quality, state } = await ready();
    quality.refreshForm();
    quality.refreshForm();
    await flush();
    assert.equal(state.profilesCalls, 1);
  });

  it("si no se pueden cargar las normas, el panel sigue con las que conoce el cliente por nombre", async () => {
    const { el } = await ready({ profilesError: ApiError.network() });
    assert.equal(el("quality-panel").hidden, false);
    assert.equal(el("quality-check").disabled, true);
    assert.match(el("quality-status").textContent, new RegExp(t("error.network").slice(0, 10)));
  });
});

describe("revisar", () => {
  it("pide el informe del trabajo con la norma elegida y pinta el resumen", async () => {
    const { el, state } = await ready();
    el("quality-check").click();
    await flush();
    assert.deepEqual(state.reportCalls.map(({ jobId, profile }) => [jobId, profile]), [[JOB, "netflix-es"]]);
    assert.equal(el("quality-summary").textContent, t("quality.summary", { score: 50, errors: 2, warnings: 3, infos: 0 }));
  });

  it("cada incidencia dice su gravedad con palabras (no solo con color), el subtítulo y las cifras", async () => {
    const { el } = await ready();
    el("quality-check").click();
    await flush();
    const items = el("quality-issues").children.map((li) => texts(li).join(" "));
    assert.equal(items.length, 2);
    assert.match(items[0], new RegExp(t("quality.severity.warning")));
    assert.match(items[0], /Subtítulo 3/); // el índice 2 se muestra como 3
    assert.match(items[0], /21,5/);
    assert.match(items[1], new RegExp(t("quality.severity.error")));
    assert.match(items[1], /línea 2/);
    assert.match(items[1], /50/);
  });

  it("muestra como mucho 50 incidencias y cuenta las demás", async () => {
    const many = Array.from({ length: 80 }, (_, i) => issue({ segment: i }));
    const { el } = await ready({ report: { ...REPORT, issues: many } });
    el("quality-check").click();
    await flush();
    assert.equal(el("quality-issues").children.length, 51);
    assert.equal(el("quality-issues").children[50].textContent, t("quality.more", { count: 30 }));
  });

  it("sin problemas dice que todo está bien y no ofrece arreglo", async () => {
    const clean = { ...REPORT, summary: summary({ errors: 0, warnings: 0, score: 100 }), issues: [] };
    const { el } = await ready({ report: clean });
    el("quality-check").click();
    await flush();
    assert.equal(el("quality-summary").textContent, t("quality.clean", { score: 100 }));
    assert.equal(el("quality-fix").hidden, true);
    assert.equal(el("quality-issues").children.length, 0);
  });

  it("un segundo clic mientras se revisa no manda otra petición", async () => {
    const { el, state } = await ready();
    el("quality-check").click();
    el("quality-check").click();
    await flush();
    assert.equal(state.reportCalls.length, 1);
  });

  it("un error del servidor sale por su código traducido, nunca con el texto que mande el servidor", async () => {
    const { el } = await ready({ reportError: new ApiError({ status: 409, code: "conflict", detail: "TEXTO-INTERNO-DEL-SERVIDOR" }) });
    el("quality-check").click();
    await flush();
    assert.ok(el("quality-status").textContent.length > 0);
    assert.doesNotMatch(texts(el("quality-panel")).join("\n"), /TEXTO-INTERNO-DEL-SERVIDOR/);
  });

  it("anuncia el resultado para lectores de pantalla", async () => {
    const { el, state } = await ready();
    el("quality-check").click();
    await flush();
    assert.ok(state.announced.includes(t("quality.summary", { score: 50, errors: 2, warnings: 3, infos: 0 })));
  });
});

describe("proponer y aplicar el arreglo", () => {
  it("solo quien puede editar ve el botón de arreglo", async () => {
    const reader = await ready({ canEdit: false });
    reader.el("quality-check").click();
    await flush();
    assert.equal(reader.el("quality-fix").hidden, true);
    const editor = await ready();
    editor.el("quality-check").click();
    await flush();
    assert.equal(editor.el("quality-fix").hidden, false);
  });

  async function proposed(options) {
    const made = await ready(options);
    made.el("quality-check").click();
    await flush();
    made.el("quality-fix").click();
    await flush();
    return made;
  }

  it("muestra qué cambia (resumen, lista y lo que no se puede arreglar) antes de tocar nada", async () => {
    const { el, state } = await proposed();
    assert.deepEqual(state.fixCalls.map(({ jobId, profile }) => [jobId, profile]), [[JOB, "netflix-es"]]);
    assert.equal(el("quality-proposal").hidden, false);
    assert.equal(el("quality-proposal-summary").textContent, t("quality.proposal.summary", { count: 2, errorsBefore: 2, errorsAfter: 1, warningsBefore: 3, warningsAfter: 2 }));
    const changes = el("quality-proposal-changes").children.map((li) => li.textContent);
    assert.equal(changes.length, 2);
    assert.ok(changes.some((text) => text === t("quality.change.line_break", { n: 5 })));
    assert.ok(changes.some((text) => /3,2/.test(text)));
    assert.equal(el("quality-proposal-unfixable").textContent, t("quality.unfixable", { count: 1 }));
    assert.equal(state.applied.length, 0, "proponer no guarda nada");
  });

  it("aplicar manda las ediciones con el mismo etag, recarga los subtítulos y vuelve a revisar", async () => {
    const { el, state } = await proposed();
    el("quality-apply").click();
    await flush();
    assert.equal(state.applied.length, 1);
    assert.equal(state.applied[0].jobId, JOB);
    assert.equal(state.applied[0].etag, "e1");
    assert.deepEqual(state.applied[0].edits, FIX.edits);
    assert.equal(state.onApplied, 1);
    assert.equal(state.reportCalls.length, 2, "revisa de nuevo tras aplicar");
    assert.equal(el("quality-proposal").hidden, true);
    assert.ok(state.announced.includes(t("quality.applied", { count: 2 })));
  });

  it("descartar cierra la propuesta sin guardar nada", async () => {
    const { el, state } = await proposed();
    el("quality-discard").click();
    assert.equal(el("quality-proposal").hidden, true);
    assert.equal(state.applied.length, 0);
  });

  it("si los subtítulos cambiaron (409) lo dice y obliga a revisar de nuevo, sin recargar", async () => {
    const { el, state } = await proposed({ applyError: new ApiError({ status: 409, code: "conflict" }) });
    el("quality-apply").click();
    await flush();
    assert.equal(el("quality-status").textContent, t("quality.stale"));
    assert.equal(el("quality-proposal").hidden, true);
    assert.equal(state.onApplied, 0);
  });

  it("sin nada que arreglar no ofrece aplicar", async () => {
    const { el } = await proposed({ fix: { ...FIX, edits: [], changes: [], after: FIX.before } });
    assert.equal(el("quality-proposal-summary").textContent, t("quality.proposal.none"));
    assert.equal(el("quality-apply").hidden, true);
  });

  it("un segundo clic en aplicar no manda dos veces", async () => {
    const { el, state } = await proposed();
    el("quality-apply").click();
    el("quality-apply").click();
    await flush();
    assert.equal(state.applied.length, 1);
  });
});

describe("cambiar de transcripción", () => {
  it("limpia el informe y la propuesta de la anterior", async () => {
    const made = await ready();
    made.el("quality-check").click();
    await flush();
    made.el("quality-fix").click();
    await flush();
    made.state.context = { job: { id: OTHER_JOB }, dirty: false, language: "es" };
    made.quality.refreshForm();
    await flush();
    assert.equal(made.el("quality-proposal").hidden, true);
    assert.equal(made.el("quality-issues").children.length, 0);
    assert.equal(made.el("quality-summary").textContent, "");
  });
});
