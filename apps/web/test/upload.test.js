import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ApiError } from "../public/js/api/errors.js";
import { normalizeOptions, precheckFile, uploadVideo, videoMimeType } from "../public/js/api/upload.js";
import { FakeXHR, fakeFile } from "./helpers/fake-xhr.js";

const createXhr = () => new FakeXHR();
const JOB = { id: "6f1d2c3e-1111-4222-8333-444455556666", status: "QUEUED", percent: 0 };

beforeEach(() => FakeXHR.reset());

/** Lanza la subida y devuelve la promesa junto con el XHR que se usó. */
function start(overrides = {}) {
  const events = [];
  const promise = uploadVideo({
    file: fakeFile(),
    options: { modelSize: "base", sourceLanguage: "", translateTo: "es" },
    createXhr,
    onProgress: (event) => events.push(event),
    ...overrides,
  });
  return { promise, events, xhr: FakeXHR.last };
}

describe("la petición", () => {
  it("es un POST multipart a /v1/jobs/transcribe", async () => {
    const { promise, xhr } = start();
    assert.equal(xhr.method, "POST");
    assert.equal(xhr.url, "/v1/jobs/transcribe");
    assert.ok(xhr.sent instanceof FormData);
    xhr.respond(202, JOB);
    await promise;
  });

  it("`options` va ANTES de `file`: el API deja de leer en cuanto llega el archivo", async () => {
    const { promise, xhr } = start();
    const names = [...xhr.sent.keys()];
    assert.deepEqual(names, ["options", "file"]);
    xhr.respond(202, JOB);
    await promise;
  });

  it("`options` viaja como JSON con null en los campos vacíos, nunca como cadena vacía", async () => {
    const { promise, xhr } = start();
    assert.deepEqual(JSON.parse(String(xhr.sent.get("options"))), { modelSize: "base", sourceLanguage: null, translateTo: "es", cleanAudio: false, diarize: false });
    xhr.respond(202, JOB);
    await promise;
  });

  it("no fija Content-Type: el navegador pone el límite (boundary) del multipart", async () => {
    const { promise, xhr } = start();
    assert.equal(xhr.headers["content-type"], undefined);
    xhr.respond(202, JOB);
    await promise;
  });

  it("respeta la base de URL configurada (despliegue con la interfaz en otro origen)", async () => {
    const { promise, xhr } = start({ baseUrl: "https://api.ejemplo.com" });
    assert.equal(xhr.url, "https://api.ejemplo.com/v1/jobs/transcribe");
    xhr.respond(202, JOB);
    await promise;
  });

  it("sin timeout propio: un video grande puede tardar horas y el API ya corta lo lento (408)", async () => {
    const { promise, xhr } = start();
    assert.equal(xhr.timeout, 0);
    xhr.respond(202, JOB);
    await promise;
  });
});

describe("el tipo del archivo", () => {
  it("un .mkv que el navegador declara vacío se envía como video/x-matroska (el API valida el mimetype, no la extensión)", async () => {
    const { promise, xhr } = start({ file: fakeFile("peli.mkv", { type: "" }) });
    assert.equal(xhr.sent.get("file").type, "video/x-matroska");
    assert.equal(xhr.sent.get("file").name, "peli.mkv");
    xhr.respond(202, JOB);
    await promise;
  });

  it("un tipo válido se conserva", () => {
    assert.equal(videoMimeType(fakeFile("a.mp4", { type: "video/mp4" })), "video/mp4");
  });

  for (const [name, expected] of [
    ["a.mp4", "video/mp4"],
    ["a.MOV", "video/quicktime"],
    ["a.mkv", "video/x-matroska"],
    ["a.webm", "video/webm"],
    ["a.avi", "video/x-msvideo"],
  ]) {
    it(`deduce ${expected} de la extensión de ${name}`, () => {
      assert.equal(videoMimeType(fakeFile(name, { type: "application/octet-stream" })), expected);
    });
  }

  for (const [name, expected] of [
    ["a.mp3", "audio/mpeg"],
    ["a.WAV", "audio/wav"],
    ["a.m4a", "audio/mp4"],
    ["a.ogg", "audio/ogg"],
    ["a.flac", "audio/flac"],
  ]) {
    it(`deduce ${expected} de la extensión de ${name} cuando el navegador no informa el tipo`, () => {
      assert.equal(videoMimeType(fakeFile(name, { type: "" })), expected);
      assert.equal(videoMimeType(fakeFile(name, { type: "application/octet-stream" })), expected);
    });
  }

  for (const type of ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/ogg", "audio/flac", "audio/x-flac"]) {
    it(`el tipo de audio ${type} se conserva`, () => {
      assert.equal(videoMimeType(fakeFile("pista.bin", { type })), type);
    });
  }

  it("un .m4a que el navegador declara como video/mp4 se envía como audio: es lo que es", () => {
    assert.equal(videoMimeType(fakeFile("nota.m4a", { type: "video/mp4" })), "audio/mp4");
    assert.equal(videoMimeType(fakeFile("clase.mp4", { type: "video/mp4" })), "video/mp4");
  });

  it("una extensión desconocida no se disfraza de video", () => {
    assert.equal(videoMimeType(fakeFile("notas.txt", { type: "text/plain" })), "text/plain");
  });
});

describe("comprobaciones antes de subir", () => {
  const limits = { maxBytes: 1000 };

  it("un archivo válido no tiene problema", () => {
    assert.equal(precheckFile(fakeFile("a.mp4", { bytes: 500 }), limits), null);
  });

  it("un archivo vacío es una petición inválida", () => {
    const error = precheckFile(fakeFile("a.mp4", { bytes: 0 }), limits);
    assert.equal(error?.code, "invalid_request");
  });

  it("más grande que el máximo -> too_large sin tocar la red", () => {
    const error = precheckFile(fakeFile("a.mp4", { bytes: 1001 }), limits);
    assert.equal(error?.code, "too_large");
    assert.equal(error?.status, 0);
  });

  it("los cinco formatos de audio pasan la comprobación", () => {
    for (const name of ["a.mp3", "a.wav", "a.m4a", "a.ogg", "a.flac"]) assert.equal(precheckFile(fakeFile(name, { type: "", bytes: 500 }), limits), null, name);
  });

  it("un audio que el API no acepta (AAC suelto, WMA) -> unsupported_type", () => {
    for (const [name, type] of [["a.aac", "audio/aac"], ["a.wma", "audio/x-ms-wma"], ["a.weba", "audio/webm"]]) {
      assert.equal(precheckFile(fakeFile(name, { type, bytes: 10 }), limits)?.code, "unsupported_type", name);
    }
  });

  it("un tipo que el API rechazaría -> unsupported_type", () => {
    const error = precheckFile(fakeFile("notas.txt", { type: "text/plain", bytes: 10 }), limits);
    assert.equal(error?.code, "unsupported_type");
  });

  it("uploadVideo no abre ninguna petición si la comprobación falla", async () => {
    await assert.rejects(
      uploadVideo({ file: fakeFile("notas.txt", { type: "text/plain", bytes: 10 }), options: { modelSize: "base" }, createXhr, maxBytes: 1000 }),
      (error) => error instanceof ApiError && error.code === "unsupported_type",
    );
    assert.equal(FakeXHR.instances.length, 0);
  });
});

describe("normalizeOptions", () => {
  it("rellena el modelo por defecto y convierte vacíos en null", () => {
    assert.deepEqual(normalizeOptions({}), { modelSize: "small", sourceLanguage: null, translateTo: null, cleanAudio: false, diarize: false });
    assert.deepEqual(normalizeOptions({ modelSize: "medium", sourceLanguage: "en", translateTo: "" }), {
      modelSize: "medium",
      sourceLanguage: "en",
      translateTo: null,
      cleanAudio: false,
      diarize: false,
    });
  });

  it("diarize: booleano, false por defecto; cualquier otro tipo se rechaza antes de subir", () => {
    assert.equal(normalizeOptions({ diarize: true }).diarize, true);
    assert.equal(normalizeOptions({ diarize: false }).diarize, false);
    for (const bad of ["true", 1, 0, null, [], {}]) assert.throws(() => normalizeOptions({ diarize: bad }), /diarize/, JSON.stringify(bad));
  });

  it("cleanAudio: booleano, false por defecto; cualquier otro tipo se rechaza antes de subir", () => {
    assert.equal(normalizeOptions({ cleanAudio: true }).cleanAudio, true);
    assert.equal(normalizeOptions({ cleanAudio: false }).cleanAudio, false);
    for (const bad of ["true", 1, 0, null, [], {}]) assert.throws(() => normalizeOptions({ cleanAudio: bad }), /cleanAudio/, JSON.stringify(bad));
  });

  it("rechaza un modelo desconocido y un código de idioma raro (el API los rechazaría con 400)", () => {
    assert.throws(() => normalizeOptions({ modelSize: "gigante" }), /modelSize/);
    assert.throws(() => normalizeOptions({ sourceLanguage: "español" }), /sourceLanguage/);
    assert.throws(() => normalizeOptions({ translateTo: "EN" }), /translateTo/);
  });
});

describe("progreso", () => {
  it("reporta bytes y fracción mientras sube", async () => {
    const { promise, events, xhr } = start();
    xhr.progress(250, 1000);
    xhr.progress(500, 1000);
    assert.deepEqual(events, [
      { phase: "uploading", loaded: 250, total: 1000, fraction: 0.25 },
      { phase: "uploading", loaded: 500, total: 1000, fraction: 0.5 },
    ]);
    xhr.respond(202, JOB);
    await promise;
  });

  it("ignora un evento sin longitud calculable (no se puede dibujar una barra con él)", async () => {
    const { promise, events, xhr } = start();
    xhr.progress(100, 0, false);
    assert.deepEqual(events, []);
    xhr.respond(202, JOB);
    await promise;
  });

  it("limita la fracción a [0, 1] aunque el navegador cuente de más", async () => {
    const { promise, events, xhr } = start();
    xhr.progress(1200, 1000);
    assert.equal(events[0].fraction, 1);
    xhr.respond(202, JOB);
    await promise;
  });

  it("al terminar de enviar pasa a 'finalizing': el 202 solo llega cuando todo el archivo está en S3", async () => {
    const { promise, events, xhr } = start();
    xhr.progress(1000, 1000);
    xhr.uploadDone();
    assert.deepEqual(events.at(-1), { phase: "finalizing", loaded: 1000, total: 1000, fraction: 1 });
    xhr.respond(202, JOB);
    await promise;
  });

  it("un onProgress que lanza una excepción no rompe la subida", async () => {
    const { promise, xhr } = start({
      onProgress: () => {
        throw new Error("fallo de la interfaz");
      },
    });
    xhr.progress(10, 100);
    xhr.respond(202, JOB);
    assert.deepEqual(await promise, JOB);
  });
});

describe("respuestas", () => {
  it("202 con el trabajo -> resuelve con él", async () => {
    const { promise, xhr } = start();
    xhr.respond(202, JOB);
    assert.deepEqual(await promise, JOB);
  });

  it("2xx sin `id` -> bad_response (no se da por buena una respuesta que no es del API)", async () => {
    const { promise, xhr } = start();
    xhr.respond(200, "<html>captive portal</html>");
    await assert.rejects(promise, (error) => error.code === "bad_response");
  });

  const failures = [
    [400, { message: ["options inválido"] }, "invalid_request"],
    [401, { message: "Falta la clave" }, "unauthorized"],
    [403, { message: "Origen no permitido." }, "forbidden"],
    [408, { message: "La subida es demasiado lenta." }, "too_slow"],
    [413, { message: "El archivo supera el máximo." }, "too_large"],
    [415, { message: "Tipo de archivo no admitido: text/plain" }, "unsupported_type"],
    [421, { message: "Host no permitido." }, "misdirected"],
    [429, { message: "Demasiadas peticiones." }, "rate_limited"],
    [503, { message: "Servidor ocupado." }, "busy"],
  ];
  for (const [status, body, code] of failures) {
    it(`${status} -> rechaza con ${code}`, async () => {
      const { promise, xhr } = start();
      xhr.respond(status, body, status === 429 || status === 503 ? { "Retry-After": "10" } : {});
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
      });
    });
  }

  it("429 y 503 conservan Retry-After para decir cuánto esperar", async () => {
    for (const status of [429, 503]) {
      FakeXHR.reset();
      const { promise, xhr } = start();
      xhr.respond(status, {}, { "Retry-After": "10" });
      await assert.rejects(promise, (error) => error.retryAfter === 10 && error.retryable === true);
    }
  });

  it("corte de red durante la subida -> 'network' (ambiguo: el API cierra la conexión al rechazar antes de leer el cuerpo)", async () => {
    const { promise, xhr } = start();
    xhr.progress(500, 1000);
    xhr.networkError();
    await assert.rejects(promise, (error) => error.code === "network" && error.status === 0 && error.retryable === true);
  });

  it("timeout del navegador -> 'timeout'", async () => {
    const { promise, xhr } = start();
    xhr.timedOut();
    await assert.rejects(promise, (error) => error.code === "timeout");
  });

  it("una vez resuelta, los eventos tardíos no cambian el resultado", async () => {
    const { promise, xhr } = start();
    xhr.respond(202, JOB);
    xhr.networkError();
    xhr.respond(500, {});
    assert.deepEqual(await promise, JOB);
  });
});

describe("cancelación", () => {
  it("abortar la señal aborta el XHR y rechaza con 'aborted'", async () => {
    const controller = new AbortController();
    const { promise, xhr } = start({ signal: controller.signal });
    xhr.progress(100, 1000);
    controller.abort();
    assert.equal(xhr.aborted, true);
    await assert.rejects(promise, (error) => error.code === "aborted" && error.name === "AbortError");
  });

  it("una señal ya abortada no abre la petición", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(start({ signal: controller.signal }).promise, (error) => error.code === "aborted");
    assert.equal(FakeXHR.instances.length, 0);
  });

  it("cancelar durante 'finalizing' también funciona (el servidor descarta lo subido)", async () => {
    const controller = new AbortController();
    const { promise, xhr } = start({ signal: controller.signal });
    xhr.uploadDone();
    controller.abort();
    assert.equal(xhr.aborted, true);
    await assert.rejects(promise, (error) => error.code === "aborted");
  });

  it("cancelar después de terminar no hace nada", async () => {
    const controller = new AbortController();
    const { promise, xhr } = start({ signal: controller.signal });
    xhr.respond(202, JOB);
    await promise;
    controller.abort();
    assert.equal(xhr.aborted, false);
  });
});
