/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration */
// beta.sh (ADR-0018) на поддельной установке 0.4.8: версия, current, data/active.json и зеркало
// repo; установленный `iva` — заглушка, которая записывает, что её позвали обновлять.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const BETA = fileURLToPath(new URL("../beta.sh", import.meta.url));
const STUB = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.IVA_TEST_HANDOFF, process.argv.slice(1).join(" ") + "\\n");
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const config = (repo: string, key: string) =>
  spawnSync("git", ["-C", repo, "config", "--local", "--get", key], {
    encoding: "utf8",
  }).stdout.trim();

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-beta-sh-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "iva");
  const handoff = join(dir, "handoff.log");
  const run = () =>
    spawnSync("bash", [BETA], {
      encoding: "utf8",
      env: {
        ...process.env,
        IVA_INSTALL_DIR: home,
        IVA_TEST_HANDOFF: handoff,
        AGENT_LANGUAGE: "en",
      },
    });
  return { dir, home, handoff, run };
}

test("beta.sh on a 0.4.8 installation: branch beta and iva.beta in the mirror, then its own iva update", (t) => {
  const { dir, home, handoff, run } = fixture(t);
  const version = join(home, "versions", "0.4.8-0123456789ab");
  mkdirSync(join(version, "bin"), { recursive: true });
  mkdirSync(join(home, "data"));
  writeFileSync(join(version, "bin/iva.mjs"), STUB);
  symlinkSync(version, join(home, "current"));
  writeFileSync(
    join(home, "data/active.json"),
    '{"schema":"iva-active/v2","version":"0.4.8-0123456789ab"}\n',
  );
  git(dir, "init", "-q", "--bare", "-b", "main", join(home, "repo"));
  git(join(home, "repo"), "config", "iva.updateBranch", "main");

  const result = run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(config(join(home, "repo"), "iva.updateBranch"), "beta");
  assert.equal(config(join(home, "repo"), "iva.beta"), "true");
  assert.equal(
    readFileSync(handoff, "utf8"),
    `${home}/current/bin/iva.mjs update\n`,
  );
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
  assert.match(result.stdout, /beta/u);
  assert.equal(
    readFileSync(join(home, "data/active.json"), "utf8").includes("0.4.8"),
    true,
  );
});

test("beta.sh on a checkout: the checkout's git gets the setting, and a missing Iva is refused", (t) => {
  const { home, handoff, run } = fixture(t);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin/iva.mjs"), STUB);
  git(home, "init", "-q", "-b", "main");
  git(home, "config", "iva.updateBranch", "main");

  const result = run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(config(home, "iva.updateBranch"), "beta");
  assert.equal(config(home, "iva.beta"), "true");
  assert.equal(readFileSync(handoff, "utf8"), `${home}/bin/iva.mjs update\n`);

  rmSync(home, { recursive: true, force: true });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/u);
});
