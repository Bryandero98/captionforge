// El puerto en el que se publica CaptionForge (CF_PORT, por defecto 3000): una sola fuente de verdad para docker-compose.yml, start.sh y start.bat.
// Se ejecutan de verdad tools/read-port.sh (start.sh) y tools/read-port.ps1 (start.bat) en una carpeta temporal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const folders = [];
const have = (command, args) => spawnSync(command, args, { encoding: "utf8" }).status === 0;
const hasBash = have("bash", ["-c", "exit 0"]);
const POWERSHELL = ["pwsh", "powershell"].find((name) => have(name, ["-NoProfile", "-Command", "exit 0"]));

function workspace(env) {
  const dir = mkdtempSync(join(tmpdir(), "cf-port-"));
  folders.push(dir);
  if (env !== undefined) writeFileSync(join(dir, ".env"), env);
  return dir;
}
const cleanEnv = (extra = {}) => {
  const { CF_PORT: _ignored, ...rest } = process.env;
  return { ...rest, ...extra };
};

const resolvers = [
  {
    name: "tools/read-port.sh (start.sh)",
    skip: !hasBash && "no hay bash",
    run: (dir, extra) => spawnSync("bash", [join(root, "tools", "read-port.sh")], { cwd: dir, encoding: "utf8", env: cleanEnv(extra) }),
  },
  {
    name: "tools/read-port.ps1 (start.bat)",
    skip: POWERSHELL === undefined && "no hay PowerShell",
    run: (dir, extra) => spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "read-port.ps1")], { cwd: dir, encoding: "utf8", env: cleanEnv(extra) }),
  },
];

after(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

for (const resolver of resolvers) {
  describe(resolver.name, { skip: resolver.skip || false }, () => {
    it("sin nada configurado usa 3000", () => {
      const result = resolver.run(workspace());
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "3000");
    });

    it("lee CF_PORT de .env", () => {
      const result = resolver.run(workspace("POSTGRES_PASSWORD=x\nCF_PORT=3456\n"));
      assert.equal(result.stdout.trim(), "3456");
    });

    it("lee CF_PORT de .env con salto de línea de Windows y espacios", () => {
      const result = resolver.run(workspace("CF_PORT= 4567 \r\nOTRA=1\r\n"));
      assert.equal(result.stdout.trim(), "4567");
    });

    it("la variable de entorno manda sobre .env", () => {
      const result = resolver.run(workspace("CF_PORT=3456\n"), { CF_PORT: "8080" });
      assert.equal(result.stdout.trim(), "8080");
    });

    it("un CF_PORT vacío en .env usa 3000", () => {
      assert.equal(resolver.run(workspace("CF_PORT=\n")).stdout.trim(), "3000");
    });

    it("con varias líneas CF_PORT manda la última, como hace docker compose", () => {
      assert.equal(resolver.run(workspace("CF_PORT=3111\nCF_PORT=3222\n")).stdout.trim(), "3222");
    });

    it("normaliza ceros a la izquierda", () => {
      assert.equal(resolver.run(workspace("CF_PORT=03001\n")).stdout.trim(), "3001");
    });

    for (const bad of ["0", "65536", "99999999999999999999", "abc", "30 00", "3000;rm -rf /", "-1", "3000.5", '"3000"']) {
      it(`rechaza CF_PORT=${JSON.stringify(bad)} sin imprimir un puerto`, () => {
        const result = resolver.run(workspace(`CF_PORT=${bad}\n`));
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout.trim(), "");
        assert.match(result.stderr, /CF_PORT/);
      });
    }
  });
}

describe("los archivos de arranque usan la misma variable", () => {
  const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

  it(".env.example expone CF_PORT=3000 y explica para qué sirve", () => {
    const text = read(".env.example");
    assert.match(text, /^CF_PORT=3000\s*$/m);
    assert.match(text.split("CF_PORT=3000")[0].split("\n").slice(-4).join("\n"), /puerto/i);
  });

  it("docker-compose.yml publica el API en ${CF_PORT:-3000} (solo en 127.0.0.1) y el puerto interno no cambia", () => {
    const text = read("docker-compose.yml");
    assert.match(text, /"127\.0\.0\.1:\$\{CF_PORT:-3000\}:3000"/);
    assert.doesNotMatch(text, /"127\.0\.0\.1:3000:3000"/);
  });

  it("start.sh y start.bat resuelven el puerto con el mismo script que .env y lo pasan a docker compose", () => {
    const sh = read("start.sh");
    assert.match(sh, /tools\/read-port\.sh/);
    assert.match(sh, /export CF_PORT=/);
    const bat = read("start.bat");
    assert.match(bat, /tools\\read-port\.ps1/);
    assert.match(bat, /set "CF_PORT=%PORT%"/);
  });
});
