// XMLHttpRequest falso y determinista: la prueba decide cuándo hay progreso, respuesta, corte o aborto.

export class FakeXHR {
  /** @type {FakeXHR[]} */
  static instances = [];

  static reset() {
    FakeXHR.instances = [];
  }

  static get last() {
    return FakeXHR.instances[FakeXHR.instances.length - 1];
  }

  constructor() {
    this.upload = {};
    this.headers = {};
    this.aborted = false;
    this.sent = undefined;
    this.timeout = 0;
    this.responseType = "";
    this.status = 0;
    this.responseText = "";
    this.responseHeaders = {};
    FakeXHR.instances.push(this);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  send(body) {
    this.sent = body;
  }

  getResponseHeader(name) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  /** Como el XHR real: abortar dispara `abort`. */
  abort() {
    this.aborted = true;
    this.onabort?.({});
  }

  // --- guion de la prueba ---
  progress(loaded, total, lengthComputable = true) {
    this.upload.onprogress?.({ lengthComputable, loaded, total });
  }

  uploadDone() {
    this.upload.onload?.({});
  }

  respond(status, body, headers = {}) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.responseHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.onload?.({});
  }

  networkError() {
    this.onerror?.({});
  }

  timedOut() {
    this.ontimeout?.({});
  }
}

/** Un archivo de prueba sin leer disco. */
export function fakeFile(name = "clip.mp4", { type = "video/mp4", bytes = 1024 } = {}) {
  return new File([new Uint8Array(bytes)], name, { type });
}
