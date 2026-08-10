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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRoot,
  isManagedInstall,
  shimScript,
} from "./version-layout.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function installation(t: { after(fn: () => void): void }): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-shim-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Built in release order, which is the reverse of the order their names sort in.
  for (const [name, age] of [
    ["0.3.9-bbbbbbbbbbbb", 2],
    ["0.3.14-aaaaaaaaaaaa", 1],
  ] as const) {
    mkdirSync(join(home, "versions", name, "bin"), { recursive: true });
    writeFileSync(
      join(home, "versions", name, "bin/iva.mjs"),
      `process.stdout.write(${JSON.stringify(name)});\n`,
    );
    const at = new Date(Date.now() - age * 60_000);
    utimesSync(join(home, "versions", name), at, at);
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

  // `current` is lost - the state the shim exists to survive.
  writeFileSync(
    join(home, "data/active.json"),
    `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.14-aaaaaaaaaaaa" })}\n`,
  );
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // No marker to go by: running something still beats running nothing, because
  // the command that repairs the installation is this one - and the newest build,
  // not the name that sorts last, or the repair starts an older release.
  rmSync(join(home, "data/active.json"));
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // And an active version outranks both.
  symlinkSync(join(home, "versions/0.3.9-bbbbbbbbbbbb"), join(home, "current"));
  assert.equal(run(), "0.3.9-bbbbbbbbbbbb");
});

test("a checkout somebody develops in is never converted, however the shim points", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-managed-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "iva",
        GIT_AUTHOR_EMAIL: "iva@example.com",
        GIT_COMMITTER_NAME: "iva",
        GIT_COMMITTER_EMAIL: "iva@example.com",
      },
    }).trim();
  const upstream = join(dir, "upstream.git");
  const source = join(dir, "source");
  const home = join(dir, "iva");
  git(dir, "init", "--bare", "--initial-branch=main", upstream);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), "{}\n");
  git(source, "init", "--initial-branch=main");
  git(source, "add", "-A");
  git(source, "commit", "-m", "initial");
  git(source, "push", "-q", upstream, "main");
  git(dir, "clone", "-q", upstream, home);

  // Exactly what install.sh leaves behind: one branch, nothing of the user's own
  // on top of it, and a shim on PATH that runs it.
  const shim = join(dir, "iva-shim");
  writeFileSync(shim, shimScript(home, process.execPath));
  const managed = (): boolean => isManagedInstall(classifyRoot(home), shim);
  assert.equal(managed(), true);

  // The deliberate ceiling of the test: an installation is free to have edits of
  // its own - preserving them is what the checkout-era updater is for - so dirt
  // alone cannot mean somebody develops here. History is the only tell.
  writeFileSync(join(home, "package.json"), '{ "edited": true }\n');
  assert.equal(managed(), true);

  // A branch of their own: a working tree, not an installation. Converting it
  // would retire the checkout somebody is working in.
  git(home, "checkout", "-q", "-b", "feature");
  assert.equal(managed(), false);

  // And commits of their own on the branch that tracks upstream.
  git(home, "checkout", "-q", "main");
  git(home, "branch", "-D", "feature");
  assert.equal(managed(), true);
  git(home, "commit", "-q", "--allow-empty", "-m", "mine");
  assert.equal(managed(), false);
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
