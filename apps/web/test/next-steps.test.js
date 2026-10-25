// «¿Qué quieres hacer ahora?» (v1.3.1): qué ofrecer tras transcribir según sea audio o video.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextSteps } from "../public/js/domain/next-steps.js";

describe("nextSteps", () => {
  it("ofrece descargar, traducir, doblar y poner subtítulos en el video, en ese orden", () => {
    assert.deepEqual(nextSteps({ mediaKind: "video" }).map((step) => step.id), ["srt", "translate", "dub", "video"]);
  });

  it("con un video todo está disponible", () => {
    for (const step of nextSteps({ mediaKind: "video" })) assert.equal(step.available, true, step.id);
  });

  it("con un audio no hay imagen donde quemar: «video» no está disponible y dice por qué; lo demás sí", () => {
    const steps = nextSteps({ mediaKind: "audio" });
    const video = steps.find((step) => step.id === "video");
    assert.equal(video.available, false);
    assert.equal(video.reason, "audio");
    for (const step of steps.filter((s) => s.id !== "video")) assert.equal(step.available, true, step.id);
  });

  it("sin dato del servidor (servidor antiguo) cuenta como video: nada se oculta por error", () => {
    for (const job of [null, undefined, {}, { mediaKind: 5 }]) assert.equal(nextSteps(job).find((step) => step.id === "video").available, true);
  });

  it("cada paso apunta al elemento que se lleva a la vista", () => {
    const targets = Object.fromEntries(nextSteps({}).map((step) => [step.id, step.target]));
    assert.deepEqual(targets, { srt: "dl-srt", translate: "translate-form", dub: "dub-form", video: "burn-form" });
  });
});
