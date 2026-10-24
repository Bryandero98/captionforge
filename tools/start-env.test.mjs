// Los generadores de .env de los scripts de arranque (tools/ensure-env.sh para start.sh y tools/new-env.ps1 para start.bat).
// Se ejecutan de verdad en una carpeta temporal con el .env.example real. Qué se exige:
//  - APP_SECRET y WORKER_INTERNAL_TOKEN salen de un generador criptográfico: 32 bytes en hexadecimal (64 caracteres), distintos entre sí y
//    aceptados por la validación del API (config.ts: hexadecimal de 64 o más caracteres, al menos 12 caracteres distintos).
//  - NUNCA se sobrescribe un valor que ya existe (cambiar APP_SECRET deja ilegibles las claves externas guardadas).
//  - Un .env anterior se completa sin tocar el resto; ningún secreto se imprime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, ".env.example");
const folders = [];

const have = (command, args) => spawnSync(command, args, { encoding: "utf8" }).status === 0;
const hasBash = have("bash", ["-c", "exit 0"]);
const POWERSHELL = ["pwsh", "powershell"].find((name) => have(name, ["-NoProfile", "-Command", "exit 0"]));

const HEX64 = /^[0-9a-f]{64}$/;
const SECRETS = ["POSTGRES_PASSWORD", "CF_OWNER_DB_PASSWORD", "CF_API_DB_PASSWORD", "CF_WORKER_DB_PASSWORD", "REDIS_PASSWORD", "S3_ROOT_PASSWORD", "S3_API_SECRET_KEY", "S3_WORKER_SECRET_KEY"];

function workspace(existing) {
  const dir = mkdtempSync(join(tmpdir(), "cf-env-"));
  folders.push(dir);
  copyFileSync(example, join(dir, ".env.example"));
  if (existing !== undefined) writeFileSync(join(dir, ".env"), existing);
  return dir;
}
const envOf = (dir) => readFileSync(join(dir, ".env"), "utf8");
const value = (text, key) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1]?.replace(/\r$/, "");
const distinct = (text) => new Set(text).size;

/**
 * Cada generador: cómo crear el .env desde cero y cómo completar uno existente.
 * start.sh llama siempre al mismo script (él decide); start.bat crea con new-env.ps1 solo si no hay .env y SIEMPRE completa con -Complete.
 */
const ps = (dir, ...extra) =>
  spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "new-env.ps1"), ...extra], { cwd: dir, encoding: "utf8" });
const generators = [
  {
    name: "tools/ensure-env.sh (start.sh)",
    skip: !hasBash && "no hay bash",
    create: (dir) => spawnSync("bash", [join(root, "tools", "ensure-env.sh")], { cwd: dir, encoding: "utf8" }),
    complete: (dir) => spawnSync("bash", [join(root, "tools", "ensure-env.sh")], { cwd: dir, encoding: "utf8" }),
  },
  {
    name: "tools/new-env.ps1 (start.bat)",
    skip: POWERSHELL === undefined && "no hay PowerShell",
    create: (dir) => ps(dir),
    complete: (dir) => ps(dir, "-Complete"),
  },
];

after(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

for (const generator of generators) {
  // Lo que hace el arranque de verdad: crear si falta el .env y, en cualquier caso, completar.
  const make = (dir) => {
    const first = existsSync(join(dir, ".env")) ? { status: 0, stdout: "", stderr: "" } : generator.create(dir);
    const second = generator.complete(dir);
    return { status: first.status || second.status, output: `${first.stdout}${first.stderr}${second.stdout}${second.stderr}` };
  };
  const complete = (dir) => generator.complete(dir);

  describe(generator.name, { skip: generator.skip || false }, () => {
    it("crea el .env con APP_SECRET y WORKER_INTERNAL_TOKEN aleatorios de 32 bytes en hexadecimal", () => {
      const dir = workspace();
      const result = make(dir);
      assert.equal(result.status, 0, result.output);
      const text = envOf(dir);
      const appSecret = value(text, "APP_SECRET");
      const token = value(text, "WORKER_INTERNAL_TOKEN");
      assert.match(appSecret, HEX64);
      assert.match(token, HEX64);
      assert.notEqual(appSecret, token, "el canal interno no puede compartir secreto con el cifrado");
      for (const secret of [appSecret, token]) assert.ok(distinct(secret) >= 12, "entropía suficiente para la validación del API");
      assert.match(value(text, "DEFAULT_API_KEY"), /^cfk_[0-9a-f]{64}$/);
      for (const name of SECRETS) assert.match(value(text, name), /^[0-9a-f]{36}$/, name);
    });

    it("cada ejecución genera valores distintos (no hay un secreto fijo)", () => {
      const first = workspace();
      const second = workspace();
      make(first);
      make(second);
      assert.notEqual(value(envOf(first), "APP_SECRET"), value(envOf(second), "APP_SECRET"));
      assert.notEqual(value(envOf(first), "WORKER_INTERNAL_TOKEN"), value(envOf(second), "WORKER_INTERNAL_TOKEN"));
    });

    it("no imprime ningún secreto", () => {
      const dir = workspace();
      const result = make(dir);
      const text = envOf(dir);
      for (const key of ["APP_SECRET", "WORKER_INTERNAL_TOKEN", "DEFAULT_API_KEY", ...SECRETS]) {
        assert.equal(result.output.includes(value(text, key)), false, `${key} no debe salir por la consola`);
      }
    });

    it("si ya existe el .env no cambia ningún valor, ni siquiera APP_SECRET (perderlo deja ilegibles las claves guardadas)", () => {
      const dir = workspace();
      make(dir);
      const before = envOf(dir);
      const again = make(dir);
      assert.equal(again.status, 0, again.output);
      assert.equal(envOf(dir), before);
    });

    it("completa un .env anterior a BYOK sin tocar el resto", () => {
      const old = "POSTGRES_PASSWORD=aaaa\nDEFAULT_API_KEY=cfk_conservada\n# un comentario\nLOCAL_MODE=true\n";
      const dir = workspace(old);
      const result = complete(dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const text = envOf(dir);
      assert.ok(text.startsWith(old), "lo que ya estaba sigue igual y en su sitio");
      assert.match(value(text, "APP_SECRET"), HEX64);
      assert.match(value(text, "WORKER_INTERNAL_TOKEN"), HEX64);
      assert.notEqual(value(text, "APP_SECRET"), value(text, "WORKER_INTERNAL_TOKEN"));
    });

    it("solo añade lo que falta: un APP_SECRET existente se conserva y se añade el token", () => {
      const secret = "ab".repeat(16) + "cd".repeat(16);
      const dir = workspace(`DEFAULT_API_KEY=cfk_x\nAPP_SECRET=${secret}\n`);
      complete(dir);
      const text = envOf(dir);
      assert.equal(value(text, "APP_SECRET"), secret);
      assert.match(value(text, "WORKER_INTERNAL_TOKEN"), HEX64);
      assert.equal((text.match(/^APP_SECRET=/gm) ?? []).length, 1, "ni duplicados");
    });

    it("rellena las variables vacías (APP_SECRET= o con solo un salto de línea de Windows) y no deja la línea vacía duplicada", () => {
      const dir = workspace("DEFAULT_API_KEY=cfk_x\r\nAPP_SECRET=\r\nWORKER_INTERNAL_TOKEN=\r\n");
      complete(dir);
      const text = envOf(dir);
      assert.match(value(text, "APP_SECRET"), HEX64);
      assert.match(value(text, "WORKER_INTERNAL_TOKEN"), HEX64);
      assert.equal((text.match(/^APP_SECRET=/gm) ?? []).length, 1);
      assert.equal((text.match(/^WORKER_INTERNAL_TOKEN=/gm) ?? []).length, 1);
    });

    it("con un .env sin salto de línea final no pega el secreto a la última línea", () => {
      const dir = workspace("DEFAULT_API_KEY=cfk_x");
      complete(dir);
      const text = envOf(dir);
      assert.equal(value(text, "DEFAULT_API_KEY"), "cfk_x");
      assert.match(value(text, "APP_SECRET"), HEX64);
    });

    it("conserva un .env con CRLF que ya tiene los dos secretos", () => {
      const secret = "1f".repeat(32);
      const other = "2e".repeat(32);
      const original = `DEFAULT_API_KEY=cfk_x\r\nAPP_SECRET=${secret}\r\nWORKER_INTERNAL_TOKEN=${other}\r\n`;
      const dir = workspace(original);
      complete(dir);
      assert.equal(envOf(dir), original);
    });
  });
}

describe("tools/ensure-env.sh: permisos", { skip: !hasBash || process.platform === "win32" }, () => {
  it("el .env queda legible solo por su dueño (600)", () => {
    const dir = workspace();
    spawnSync("bash", [join(root, "tools", "ensure-env.sh")], { cwd: dir });
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  });
});

describe(".env.example", () => {
  const text = readFileSync(example, "utf8");
  it("lista los secretos de BYOK sin valor, sin comentar, para que los scripts los rellenen", () => {
    assert.match(text, /^APP_SECRET=\s*$/m);
    assert.match(text, /^WORKER_INTERNAL_TOKEN=\s*$/m);
  });
  it("documenta los topes de gasto por trabajo con sus valores por defecto", () => {
    assert.match(text, /^# MAX_JOB_CHARACTERS=50000\b/m);
    assert.match(text, /^# MAX_JOB_SEGMENTS=1000\b/m);
  });
});
