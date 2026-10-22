import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError, errorFromResponse, parseRetryAfter } from "../public/js/api/errors.js";
import { MAX_FILES } from "../public/js/domain/batch.js";
import { messages } from "../public/js/i18n/messages.js";

describe("errorFromResponse: cada código HTTP del API tiene un código propio y una pista de reintento", () => {
  const cases = [
    // [estado, código esperado, reintentable]
    [400, "invalid_request", false],
    [401, "unauthorized", false],
    [403, "forbidden", false],
    [404, "not_found", false],
    [408, "too_slow", false],
    [409, "conflict", false],
    [413, "too_large", false],
    [415, "unsupported_type", false],
    [421, "misdirected", false],
    [429, "rate_limited", true],
    [500, "server", true],
    [502, "server", true],
    [503, "busy", true],
    [504, "server", true],
  ];

  for (const [status, code, retryable] of cases) {
    it(`${status} -> ${code} (reintentable: ${retryable})`, () => {
      const error = errorFromResponse(status, "{}", null);
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
    });
  }

  it("un estado raro (418) cae en 'unexpected' y no inventa un reintento", () => {
    const error = errorFromResponse(418, "{}", null);
    assert.equal(error.code, "unexpected");
    assert.equal(error.retryable, false);
  });

  it("lee el formato de error de Nest { statusCode, message, error }", () => {
    const error = errorFromResponse(413, JSON.stringify({ statusCode: 413, message: "El archivo supera el máximo.", error: "Payload Too Large" }), null);
    assert.equal(error.detail, "El archivo supera el máximo.");
  });

  it("si `message` es una lista (validación), la une en una sola línea", () => {
    const error = errorFromResponse(400, JSON.stringify({ message: ["uno", "dos"] }), null);
    assert.equal(error.detail, "uno; dos");
  });

  it("un cuerpo que no es JSON (una página de error de un proxy) no rompe nada: el código sale del estado", () => {
    const error = errorFromResponse(503, "<html>Bad gateway</html>", null);
    assert.equal(error.code, "busy");
    assert.equal(error.detail, null);
  });

  it("el detalle del servidor se recorta: un cuerpo enorme no llena la pantalla", () => {
    const error = errorFromResponse(400, JSON.stringify({ message: "x".repeat(5000) }), null);
    assert.ok((error.detail ?? "").length <= 300);
  });

  it("guarda Retry-After en segundos", () => {
    assert.equal(errorFromResponse(429, "{}", "10").retryAfter, 10);
    assert.equal(errorFromResponse(503, "{}", "30").retryAfter, 30);
  });
});

describe("parseRetryAfter", () => {
  it("acepta segundos enteros", () => assert.equal(parseRetryAfter("12"), 12));
  for (const bad of [null, undefined, "", "abc", "-3", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    it(`ignora ${JSON.stringify(bad)}`, () => assert.equal(parseRetryAfter(bad), null));
  }
  it("pone un techo: un servidor no puede pedir esperar una hora", () => {
    assert.equal(parseRetryAfter("99999"), 300);
  });
});

describe("errores que no vienen de una respuesta", () => {
  it("ApiError.network: sin respuesta, ambiguo y reintentable", () => {
    const error = ApiError.network();
    assert.equal(error.code, "network");
    assert.equal(error.status, 0);
    assert.equal(error.retryable, true);
  });

  it("ApiError.aborted: lo cancela la persona, no es un fallo", () => {
    const error = ApiError.aborted();
    assert.equal(error.code, "aborted");
    assert.equal(error.name, "AbortError");
    assert.equal(error.retryable, true);
  });

  it("ApiError.local fija el código sin estado HTTP", () => {
    const error = ApiError.local("too_large", "pesa mucho");
    assert.equal(error.status, 0);
    assert.equal(error.code, "too_large");
    assert.equal(error.detail, "pesa mucho");
    assert.equal(error.retryable, false);
  });
});

describe("textos: todo código de error tiene mensaje en español e inglés", () => {
  const codes = new Set([
    "invalid_request", "unauthorized", "forbidden", "not_found", "too_slow", "conflict", "too_large", "unsupported_type",
    "misdirected", "rate_limited", "server", "busy", "network", "aborted", "unexpected", "bad_response", "timeout",
  ]);
  for (const lang of ["es", "en"]) {
    for (const code of codes) {
      it(`${lang}: error.${code}`, () => {
        const text = messages[lang][`error.${code}`];
        assert.equal(typeof text, "string");
        assert.ok(text.length > 0);
      });
    }
  }

  it("los mensajes con {seconds} lo usan en los dos idiomas", () => {
    for (const lang of ["es", "en"]) {
      assert.match(messages[lang]["error.rate_limited"], /\{seconds\}/);
      assert.match(messages[lang]["error.busy"], /\{seconds\}/);
    }
  });

  it("todos los idiomas tienen exactamente las mismas claves que es", () => {
    const keys = Object.keys(messages.es).sort();
    for (const lang of Object.keys(messages)) assert.deepEqual(Object.keys(messages[lang]).sort(), keys, lang);
  });

  it("cada texto conserva exactamente los marcadores {x} del original y ninguno está vacío", () => {
    const holes = (/** @type {string} */ text) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const lang of Object.keys(messages)) {
      for (const [key, text] of Object.entries(messages[lang])) {
        assert.notEqual(text.trim(), "", `${lang} ${key}`);
        assert.deepEqual(holes(text), holes(messages.es[key]), `${lang} ${key}`);
        assert.doesNotMatch(text, /<[a-z/]/i, `${lang} ${key}: sin HTML`);
      }
    }
  });

  it("la guía menciona el máximo de videos de la cola en todos los idiomas", () => {
    for (const lang of Object.keys(messages)) assert.match(messages[lang]["guide.s1.body"], new RegExp(String(MAX_FILES)), lang);
  });
});
