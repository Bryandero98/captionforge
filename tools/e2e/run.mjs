// Prueba de extremo a extremo contra el stack COMPLETO en contenedores:
//   docker compose --profile app up -d --build   (y esperar a que api-gateway y ai-worker estén healthy)
//   npm run e2e
// Sube un video, espera la transcripción con Whisper real, edita un subtítulo, quema, descarga el MP4
// (con Range) y comprueba que es un video real. La primera vez descarga el modelo (minutos).
//
// Variables: API_URL (http://127.0.0.1:3000), E2E_VIDEO (por defecto el clip de prueba del paquete
// heredado, que puede no tener voz), E2E_MODEL (base), E2E_TIMEOUT_SECONDS (900).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const api = process.env.API_URL ?? "http://127.0.0.1:3000";
const videoPath = process.env.E2E_VIDEO ?? fileURLToPath(new URL("../../legacy/tests/fixtures/tiny_test_clip.mp4", import.meta.url));
const model = process.env.E2E_MODEL ?? "base";
const timeoutMs = Number(process.env.E2E_TIMEOUT_SECONDS ?? 900) * 1000;

let step = 0;
const ok = (message) => console.log(`  ✓ ${++step}. ${message}`);
const fail = (message) => {
  console.error(`  ✗ ${message}`);
  process.exit(1);
};
const expect = (condition, message) => (condition ? undefined : fail(message));

async function json(path, init) {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitFor(id, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { body } = await json(`/v1/jobs/${id}`);
    const line = `${body.status} ${body.stage ?? "-"} ${Math.round(body.percent)}%`;
    if (line !== last) {
      console.log(`      ${label}: ${line}${body.message ? ` · ${body.message}` : ""}`);
      last = line;
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return fail(`${label}: tiempo agotado (${timeoutMs / 1000} s)`);
}

console.log(`API: ${api} · video: ${videoPath} · modelo: ${model}`);

const health = await json("/health");
expect(health.status === 200, `/health respondió ${health.status}: ${JSON.stringify(health.body)}`);
ok("el API y sus dependencias están sanos");

const form = new FormData();
form.append("options", JSON.stringify({ modelSize: model }));
form.append("file", new File([await readFile(videoPath)], "entrevista.mp4", { type: "video/mp4" }));
const created = await json("/v1/jobs/transcribe", { method: "POST", body: form });
expect(created.status === 202, `subida: ${created.status} ${JSON.stringify(created.body)}`);
const transcriptionId = created.body.id;
ok(`video subido, trabajo ${transcriptionId}`);

const transcription = await waitFor(transcriptionId, "transcripción");
expect(transcription.status === "COMPLETED", `la transcripción terminó ${transcription.status}: ${JSON.stringify(transcription.error)}`);
ok(`transcripción terminada (${transcription.result.segmentCount} segmentos, ${transcription.result.device}, idioma ${transcription.result.detectedLanguage})`);

const srt = await fetch(`${api}/v1/jobs/${transcriptionId}/artifacts/srt`);
expect(srt.status === 200, `descarga del SRT: ${srt.status}`);
ok("el SRT se puede descargar");

const segments = await json(`/v1/jobs/${transcriptionId}/segments`);
expect(segments.status === 200, `GET segments: ${segments.status}`);
if (segments.body.segments.length === 0) {
  console.log("      (el video no tiene voz: no hay subtítulos que editar ni quemar; fin de la prueba)");
  process.exit(0);
}
ok(`${segments.body.segments.length} subtítulos leídos`);

const edited = await json(`/v1/jobs/${transcriptionId}/segments`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ segments: [{ index: 0, text: "Texto corregido a mano" }], etag: segments.body.etag }),
});
expect(edited.status === 200 && edited.body.segments[0].text === "Texto corregido a mano", `PUT segments: ${edited.status}`);
ok("un subtítulo se editó y quedó guardado");

const burnRequest = await json(`/v1/jobs/${transcriptionId}/burn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ style: "youtube", karaoke: true }),
});
expect(burnRequest.status === 202, `POST burn: ${burnRequest.status} ${JSON.stringify(burnRequest.body)}`);
const burn = await waitFor(burnRequest.body.id, "quemado");
expect(burn.status === "COMPLETED", `el quemado terminó ${burn.status}: ${JSON.stringify(burn.error)}`);
ok(`quemado terminado (karaoke aplicado: ${burn.result.usedKaraoke})`);

const video = await fetch(`${api}/v1/jobs/${burn.id}/artifacts/video`);
const bytes = Buffer.from(await video.arrayBuffer());
expect(video.status === 200 && bytes.length > 1000 && bytes.subarray(4, 8).toString() === "ftyp", "el video descargado no es un MP4 válido");
ok(`video descargado: ${bytes.length} bytes, MP4 válido, nombre ${video.headers.get("content-disposition")}`);

const partial = await fetch(`${api}/v1/jobs/${burn.id}/artifacts/video`, { headers: { range: "bytes=0-1023" } });
expect(partial.status === 206 && (await partial.arrayBuffer()).byteLength === 1024, `Range: ${partial.status}`);
ok("la descarga parcial (Range) funciona");

console.log("\nExtremo a extremo correcto.");
