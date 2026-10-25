// Las fuentes de la vista previa se versionan como binarios: un cambio accidental o malicioso rompería el diseño en silencio.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");

it("cada fuente y licencia coincide con su hash de SHA256SUMS, y no sobra ni falta ninguna", () => {
  const listed = readFileSync(join(DIR, "SHA256SUMS"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, name] = line.split(/\s+\*?/);
    return [name, hash];
  });
  assert.ok(listed.length >= 4);
  // Las licencias son texto: en Windows el árbol de trabajo puede tener CRLF, y el hash es el del contenido con LF (el de git y el de la CI).
  const bytes = (name) => (name.endsWith(".txt") ? Buffer.from(readFileSync(join(DIR, name), "utf8").replaceAll("\r\n", "\n")) : readFileSync(join(DIR, name)));
  for (const [name, hash] of listed) assert.equal(createHash("sha256").update(bytes(name)).digest("hex"), hash, name);
  const files = readdirSync(DIR).filter((name) => /\.(woff|txt)$/.test(name)).sort();
  assert.deepEqual(files, listed.map(([name]) => name).sort());
});

it("las licencias OFL acompañan a las fuentes", () => {
  const files = readdirSync(DIR);
  assert.ok(files.includes("OFL-Montserrat.txt") && files.includes("OFL-Nunito.txt"));
});
