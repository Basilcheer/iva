/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shimScript } from "./version-layout.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function installation(t: { after(fn: () => void): void }): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-shim-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const name of ["0.3.14-aaaaaaaaaaaa", "0.3.9-bbbbbbbbbbbb"]) {
    mkdirSync(join(home, "versions", name, "bin"), { recursive: true });
    writeFileSync(
      join(home, "versions", name, "bin/iva.mjs"),
      `process.stdout.write(${JSON.stringify(name)});\n`,
    );
  }
  mkdirSync(join(home, "data"), { recursive: true });
  return home;
}

test("a shim without `current` runs the version the installation settled on", (t) => {
  const home = installation(t);
  const shim = join(home, "iva");
  writeFileSync(shim, shimScript(home, process.execPath));
  chmodSync(shim, 0o755);
  const run = (): string => execFileSync(shim, { encoding: "utf8" });

  // `current` is lost - the state the shim exists to survive. Sorted names put
  // the older release last, so picking the last one runs the wrong code.
  writeFileSync(
    join(home, "data/active.json"),
    `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.14-aaaaaaaaaaaa" })}\n`,
  );
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // No marker to go by: running something still beats running nothing, because
  // the command that repairs the installation is this one.
  rmSync(join(home, "data/active.json"));
  assert.equal(run(), "0.3.9-bbbbbbbbbbbb");

  // And an active version outranks both.
  symlinkSync(join(home, "versions/0.3.9-bbbbbbbbbbbb"), join(home, "current"));
  assert.equal(run(), "0.3.9-bbbbbbbbbbbb");
});

test("install.sh writes the same shim the bridge does", (t) => {
  const home = installation(t);
  const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
  const block = /\n\{\n([\s\S]*?)\n\} > "\$HOME\/\.local\/bin\/iva"\n/u.exec(
    installer,
  );
  assert.ok(block, "the shim is no longer written by a printf block");

  // The installer's own lines, run as the installer runs them: an installation
  // that never had a `current` to lose gets the same resolution rules as one the
  // bridge converted, or a lost symlink means two different behaviours.
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  execFileSync("sh", ["-c", `{\n${block[1]}\n} > "$HOME/.local/bin/iva"`], {
    env: { ...process.env, HOME: home, PROJECT_DIR: home },
  });
  const node = execFileSync("sh", ["-c", "command -v node"], {
    encoding: "utf8",
  }).trim();
  assert.equal(
    readFileSync(join(home, ".local/bin/iva"), "utf8"),
    shimScript(home, node),
  );
});
