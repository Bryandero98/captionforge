import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTranslator } from "../public/js/i18n/index.js";
import { createSpendConfirm } from "../public/js/ui/spend-confirm.js";
import { FakeDialog, FakeElement } from "./helpers/fake-dom.js";

const t = createTranslator("es");

function setup({ nativeDialog = true } = {}) {
  const dialog = nativeDialog ? new FakeDialog("spend-confirm") : new FakeElement("spend-confirm");
  const elements = {
    "spend-confirm": dialog,
    "spend-confirm-title": new FakeElement(),
    "spend-confirm-body": new FakeElement(),
    "spend-confirm-yes": new FakeElement(),
    "spend-confirm-no": new FakeElement(),
  };
  const doc = { documentElement: { lang: "es" }, activeElement: null, getElementById: (id) => elements[id] ?? null };
  return { dialog, elements, doc, spend: createSpendConfirm({ doc, t }) };
}

describe("confirmación del gasto", () => {
  it("abre el diálogo modal con el proveedor y la estimación, y no resuelve hasta que la persona decide", async () => {
    const { dialog, elements, spend } = setup();
    let settled = false;
    const answer = spend.ask({ provider: "openai", characters: 12500 }).then((value) => ((settled = true), value));
    await Promise.resolve();
    assert.equal(dialog.open, true);
    assert.equal(dialog.showModalCalls, 1);
    assert.equal(settled, false);
    assert.equal(elements["spend-confirm-title"].textContent, "¿Confirmas el gasto?");
    const body = elements["spend-confirm-body"].textContent;
    assert.match(body, /OpenAI/);
    assert.match(body, /≈\s*12[.\s ]?500 caracteres/);
    elements["spend-confirm-yes"].fire("click");
    assert.equal(await answer, true);
  });

  it("«Sí, continuar» confirma y cierra", async () => {
    const { dialog, elements, spend } = setup();
    const answer = spend.ask({ provider: "elevenlabs", characters: 10 });
    elements["spend-confirm-yes"].fire("click");
    assert.equal(await answer, true);
    assert.equal(dialog.open, false);
  });

  it("«Cancelar» rechaza y cierra", async () => {
    const { dialog, elements, spend } = setup();
    const answer = spend.ask({ provider: "openai", characters: 10 });
    elements["spend-confirm-no"].fire("click");
    assert.equal(await answer, false);
    assert.equal(dialog.open, false);
  });

  it("Esc (evento cancel del diálogo) equivale a cancelar", async () => {
    const { dialog, spend } = setup();
    const answer = spend.ask({ provider: "openai", characters: 10 });
    dialog.fire("cancel");
    assert.equal(await answer, false);
    assert.equal(dialog.open, false);
  });

  it("el foco empieza en «Cancelar»: Enter no gasta por descuido", async () => {
    const { elements, spend } = setup();
    void spend.ask({ provider: "openai", characters: 10 });
    assert.equal(elements["spend-confirm-no"].focused, true);
    assert.equal(elements["spend-confirm-yes"].focused, false);
  });

  it("al cerrar devuelve el foco al control que abrió el diálogo", async () => {
    const { elements, spend, doc } = setup();
    const opener = new FakeElement("translate-start");
    doc.activeElement = opener;
    const answer = spend.ask({ provider: "openai", characters: 10 });
    opener.focused = false;
    elements["spend-confirm-no"].fire("click");
    await answer;
    assert.equal(opener.focused, true);
  });

  it("no intenta enfocar un control que ya no está disponible", async () => {
    const { elements, spend, doc } = setup();
    const opener = new FakeElement("translate-start");
    opener.disabled = true;
    doc.activeElement = opener;
    const answer = spend.ask({ provider: "openai", characters: 10 });
    elements["spend-confirm-no"].fire("click");
    await answer;
    assert.equal(opener.focused, false);
  });

  it("una segunda petición mientras hay una abierta rechaza la primera: nunca se acumulan", async () => {
    const { dialog, elements, spend } = setup();
    const first = spend.ask({ provider: "openai", characters: 1 });
    const second = spend.ask({ provider: "openai", characters: 2 });
    assert.equal(await first, false);
    elements["spend-confirm-yes"].fire("click");
    assert.equal(await second, true);
    assert.equal(dialog.open, false);
  });

  it("sin soporte de <dialog> usa hidden y sigue funcionando", async () => {
    const { dialog, elements, spend } = setup({ nativeDialog: false });
    dialog.hidden = true;
    const answer = spend.ask({ provider: "openai", characters: 10 });
    assert.equal(dialog.hidden, false);
    elements["spend-confirm-no"].fire("click");
    assert.equal(await answer, false);
    assert.equal(dialog.hidden, true);
  });

  it("repinta en otro idioma", async () => {
    const { elements, spend } = setup();
    spend.refresh(createTranslator("en"));
    void spend.ask({ provider: "openai", characters: 10 });
    assert.equal(elements["spend-confirm-title"].textContent, "Confirm the spend?");
  });
});
