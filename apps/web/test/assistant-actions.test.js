// Acciones que propone el asistente (v1.3.1): se validan otra vez en el cliente y se traducen a operaciones sobre los botones de la página.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planAction } from "../public/js/domain/assistant-actions.js";
import { addTurn, toMessages } from "../public/js/domain/assistant.js";

describe("planAction", () => {
  it("ir a un paso pulsa el atajo de «¿Qué quieres hacer ahora?» y no gasta", () => {
    const plan = planAction({ name: "go_to_step", args: { step: "dub" } });
    assert.deepEqual(plan, { ok: true, name: "go_to_step", spend: false, ops: [{ type: "click", id: "next-dub" }] });
  });

  it("traducir con Argos elige proveedor e idioma y pulsa Traducir, sin gasto", () => {
    const plan = planAction({ name: "translate", args: { targetLanguage: "en", provider: "argos" } });
    assert.equal(plan.ok, true);
    assert.equal(plan.spend, false);
    assert.deepEqual(plan.ops, [
      { type: "select", id: "translate-provider", value: "argos" },
      { type: "select", id: "translate-target", value: "en" },
      { type: "click", id: "translate-start" },
    ]);
  });

  it("traducir con la IA propia puede costar", () => {
    assert.equal(planAction({ name: "translate", args: { targetLanguage: "es", provider: "openai" } }).spend, true);
  });

  it("doblar solo toca lo que la IA indicó y siempre avisa de que puede costar", () => {
    const plan = planAction({ name: "dub", args: { voice: "Rachel", mix: "none" } });
    assert.equal(plan.spend, true);
    assert.deepEqual(plan.ops, [
      { type: "text", id: "dub-voice", value: "Rachel" },
      { type: "select", id: "dub-mix", value: "none" },
      { type: "click", id: "dub-start" },
    ]);
    assert.deepEqual(planAction({ name: "dub", args: {} }).ops, [{ type: "click", id: "dub-start" }]);
  });

  it("quemar no es posible con un audio", () => {
    assert.deepEqual(planAction({ name: "burn", args: {} }, { audio: true }), { ok: false, reason: "audio" });
    assert.equal(planAction({ name: "burn", args: {} }).ok, true);
  });

  it("descargar el .srt pulsa el enlace de descarga", () => {
    assert.deepEqual(planAction({ name: "download_srt", args: {} }).ops, [{ type: "click", id: "dl-srt" }]);
  });

  it("rechaza lo desconocido o con argumentos raros sin generar ninguna operación", () => {
    for (const bad of [
      null,
      {},
      { name: "rm_rf", args: {} },
      { name: "go_to_step", args: { step: "../x" } },
      { name: "translate", args: { targetLanguage: "en; x", provider: "argos" } },
      { name: "translate", args: { targetLanguage: "en", provider: "otro" } },
      { name: "dub", args: { mix: "boom" } },
      { name: "dub", args: { voice: "a".repeat(65) } },
    ]) {
      const plan = planAction(/** @type {any} */ (bad));
      assert.equal(plan.ok, false, JSON.stringify(bad));
      assert.equal("ops" in plan, false);
    }
  });
});

describe("conversación con acciones", () => {
  it("guarda las acciones en el turno del asistente aunque no haya texto", () => {
    const turns = addTurn([], "assistant", "", [{ name: "burn", args: {} }]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].actions?.length, 1);
    assert.ok(turns[0].content.length > 0, "el historial que se reenvía no puede quedar vacío");
  });

  it("al reenviar la conversación solo viajan rol y texto", () => {
    const turns = addTurn(addTurn([], "user", "traduce"), "assistant", "Listo", [{ name: "translate", args: { targetLanguage: "en", provider: "argos" } }]);
    assert.deepEqual(toMessages(turns), [
      { role: "user", content: "traduce" },
      { role: "assistant", content: "Listo" },
    ]);
  });
});
