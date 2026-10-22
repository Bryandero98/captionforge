import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openEditor, dirtyCount, editsOf, renameSpeaker, saved, speakerIdsOf, speakerNameOf, speakerOf } from "../public/js/domain/editor-state.js";
import { diarizationStatus, displayName, PALETTE_SIZE, segmentsToSrtWithSpeakers, speakerColor, speakersOf } from "../public/js/domain/speakers.js";
import { segmentsToVtt } from "../public/js/domain/subtitles.js";

const ETAG = "a".repeat(32);
const seg = (index, start, end, text, speaker) => ({ index, start, end, text, words: null, ...(speaker === undefined ? {} : { speaker }) });
const SEGMENTS = [seg(0, 0, 2, " Hola", "SPEAKER_01"), seg(1, 2, 4, " Buenas", "SPEAKER_02"), seg(2, 4, 6, " Adiós", "SPEAKER_01")];

describe("diarizationStatus", () => {
  const job = (options, result) => ({ options, result });
  it("pedido e identificado", () => assert.equal(diarizationStatus(job({ diarize: true }, { diarized: true })), "identified"));
  it("pedido pero el worker entregó la transcripción normal: respaldo, y se avisa", () => {
    assert.equal(diarizationStatus(job({ diarize: true }, { diarized: false })), "fallback");
    assert.equal(diarizationStatus(job({ diarize: true }, {})), "fallback");
  });
  it("no pedido: nada que mostrar", () => {
    assert.equal(diarizationStatus(job({ diarize: false }, { diarized: false })), "none");
    assert.equal(diarizationStatus(job({}, {})), "none");
    assert.equal(diarizationStatus(null), "none");
  });
  it("valores raros no cuentan como verdadero", () => {
    assert.equal(diarizationStatus(job({ diarize: "true" }, { diarized: "true" })), "none");
  });
});

describe("speakersOf y color", () => {
  it("lista los hablantes por orden de aparición, sin repetir", () => {
    assert.deepEqual(
      speakersOf(SEGMENTS).map((s) => s.id),
      ["SPEAKER_01", "SPEAKER_02"],
    );
  });
  it("segmentos sin hablante no generan ninguno", () => {
    assert.deepEqual(speakersOf([seg(0, 0, 1, "a")]), []);
  });
  it("el color es determinista, repite a partir de la paleta y nunca sale de rango", () => {
    const colors = Array.from({ length: PALETTE_SIZE * 2 + 1 }, (_, n) => speakerColor(n));
    assert.equal(colors[0], colors[PALETTE_SIZE]);
    assert.ok(colors.every((c) => Number.isInteger(c) && c >= 0 && c < PALETTE_SIZE));
    assert.equal(new Set(colors.slice(0, PALETTE_SIZE)).size, PALETTE_SIZE);
    assert.equal(speakerColor(-1), speakerColor(PALETTE_SIZE - 1));
  });
  it("cada hablante lleva el color de su posición", () => {
    assert.deepEqual(speakersOf(SEGMENTS).map((s) => s.color), [speakerColor(0), speakerColor(1)]);
  });
});

describe("displayName", () => {
  const generic = (n) => `Hablante ${n}`;
  it("SPEAKER_nn se muestra con un nombre legible; cualquier otro nombre, tal cual", () => {
    assert.equal(displayName("SPEAKER_01", generic), "Hablante 1");
    assert.equal(displayName("SPEAKER_12", generic), "Hablante 12");
    assert.equal(displayName("Ana", generic), "Ana");
    assert.equal(displayName("SPEAKER_X", generic), "SPEAKER_X");
  });
});

describe("renombrar hablantes en el editor", () => {
  it("renombrar un hablante cambia TODOS sus subtítulos, y solo esos", () => {
    const state = renameSpeaker(openEditor(SEGMENTS, ETAG), "SPEAKER_01", "Ana");
    assert.deepEqual(editsOf(state), [
      { index: 0, speaker: "Ana" },
      { index: 2, speaker: "Ana" },
    ]);
    assert.equal(dirtyCount(state), 2);
    assert.equal(speakerOf(state, 0), "Ana");
    assert.equal(speakerOf(state, 1), "SPEAKER_02");
  });

  it("el nombre de un hablante se lee por su identificador original, y se limpia de espacios", () => {
    let state = renameSpeaker(openEditor(SEGMENTS, ETAG), "SPEAKER_01", "  Ana  ");
    assert.equal(speakerNameOf(state, "SPEAKER_01"), "Ana");
    assert.equal(speakerNameOf(state, "SPEAKER_02"), "SPEAKER_02");
    state = renameSpeaker(state, "SPEAKER_01", "SPEAKER_01"); // volver al original deshace el cambio
    assert.equal(dirtyCount(state), 0);
  });

  it("un nombre vacío restaura el original", () => {
    const state = renameSpeaker(renameSpeaker(openEditor(SEGMENTS, ETAG), "SPEAKER_02", "Luis"), "SPEAKER_02", "   ");
    assert.equal(dirtyCount(state), 0);
  });

  it("se corta a 64 caracteres, el máximo que acepta el servidor", () => {
    const state = renameSpeaker(openEditor(SEGMENTS, ETAG), "SPEAKER_02", "x".repeat(100));
    assert.equal(speakerNameOf(state, "SPEAKER_02").length, 64);
  });

  it("un hablante que no existe se ignora", () => {
    assert.equal(dirtyCount(renameSpeaker(openEditor(SEGMENTS, ETAG), "SPEAKER_99", "Ana")), 0);
  });

  it("speakerIdsOf devuelve los identificadores guardados, por orden de aparición", () => {
    assert.deepEqual(speakerIdsOf(openEditor(SEGMENTS, ETAG)), ["SPEAKER_01", "SPEAKER_02"]);
  });

  it("al guardar se adopta lo que devuelve el servidor y el cambio que se hizo mientras se guardaba sigue pendiente", () => {
    const sentState = renameSpeaker(openEditor(SEGMENTS, ETAG), "SPEAKER_01", "Ana");
    const sent = editsOf(sentState);
    const during = renameSpeaker(sentState, "SPEAKER_02", "Luis"); // el usuario siguió editando mientras se enviaba
    const server = [seg(0, 0, 2, " Hola", "Ana"), SEGMENTS[1], seg(2, 4, 6, " Adiós", "Ana")];
    const next = saved(during, server, "b".repeat(32), sent);
    assert.deepEqual(editsOf(next), [{ index: 1, speaker: "Luis" }]);
    assert.equal(next.segments[0].speaker, "Ana");
  });
});

describe("descargas con el nombre del hablante", () => {
  const nameOf = (s) => (s.speaker === "SPEAKER_01" ? "Ana" : s.speaker === "SPEAKER_02" ? "Luis" : null);
  it(".srt con prefijo «Nombre: »", () => {
    assert.equal(
      segmentsToSrtWithSpeakers([seg(0, 0, 1.5, " Hola", "SPEAKER_01"), seg(1, 2, 3, " Buenas", "SPEAKER_02")], nameOf),
      "1\n00:00:00,000 --> 00:00:01,500\nAna: Hola\n\n2\n00:00:02,000 --> 00:00:03,000\nLuis: Buenas\n",
    );
  });
  it("un subtítulo sin hablante queda sin prefijo", () => {
    assert.equal(segmentsToSrtWithSpeakers([seg(0, 0, 1, " Hola")], nameOf), "1\n00:00:00,000 --> 00:00:01,000\nHola\n");
  });
  it(".vtt acepta el mismo prefijo y escapa lo que WebVTT interpreta", () => {
    const vtt = segmentsToVtt([seg(0, 0, 1, " Hola", "SPEAKER_01")], nameOf);
    assert.equal(vtt, "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nAna: Hola\n");
    assert.match(segmentsToVtt([seg(0, 0, 1, "x", "A")], () => "<b>&"), /&lt;b&gt;&amp;: x/);
  });
  it("sin función de nombres el .vtt es el de siempre", () => {
    assert.equal(segmentsToVtt([seg(0, 0, 1, "Hola", "SPEAKER_01")]), "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHola\n");
  });
});
