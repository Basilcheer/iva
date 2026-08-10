import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LEGACY_HEAD = "9a1b00dcd0ac85eafc969ba863d0773012a3fc6e";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

void test("repair bridges a dirty legacy install and preserves arbitrary files", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-shell-"));
  const remote = join(fixture, "remote.git");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  try {
    const target = git(ROOT, "rev-parse", "HEAD");
    const repairBranch = "repair-test-target";
    execFileSync("git", ["clone", "--quiet", "--bare", ROOT, remote]);
    execFileSync(
      "git",
      ["--git-dir", remote, "update-ref", `refs/heads/${repairBranch}`, target],
      { cwd: ROOT },
    );
    execFileSync("git", ["clone", "--quiet", remote, install]);
    assert.doesNotThrow(
      () => git(install, "cat-file", "-e", `${LEGACY_HEAD}^{commit}`),
      `LEGACY_HEAD ${LEGACY_HEAD} is unreachable; run the test on a full clone`,
    );
    git(install, "checkout", "-B", "main", LEGACY_HEAD);
    git(install, "config", "user.name", "Iva Repair Test");
    git(install, "config", "user.email", "repair@example.invalid");

    writeFileSync(
      join(install, "docs/index.html"),
      "<html>local docs</html>\n",
    );
    writeFileSync(
      join(install, "scripts/telegram-poll.mjs"),
      "// local Telegram buttons\n",
    );
    writeFileSync(
      join(install, "agent/channels/eve.ts"),
      `${readFileSync(join(install, "agent/channels/eve.ts"), "utf8")}\n// local compatible change\n`,
    );
    mkdirSync(join(install, "scripts"), { recursive: true });
    writeFileSync(
      join(install, "scripts/custom-telegram-button.ts"),
      "export const customButton = true;\n",
    );
    mkdirSync(join(install, "agent/skills/my-skill"), { recursive: true });
    writeFileSync(join(install, "agent/skills/my-skill/SKILL.md"), "# Mine\n");
    writeFileSync(join(install, ".env"), "IVA_PORT=8723\n");
    mkdirSync(join(install, "data"), { recursive: true });
    writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');
    mkdirSync(join(install, ".workflow-data"), { recursive: true });
    writeFileSync(join(install, ".workflow-data/run.json"), '{"run":1}\n');
    mkdirSync(join(install, ".eve/.workflow-data"), { recursive: true });
    writeFileSync(join(install, ".eve/.workflow-data/eve.json"), '{"eve":1}\n');

    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then mkdir -p .output/server; printf ok > .output/server/index.mjs; fi\nexit 0\n',
    );
    chmodSync(fakeNpm, 0o755);

    const output = execFileSync("bash", [join(ROOT, "repair.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: install,
        IVA_REPAIR_REPO_URL: remote,
        IVA_REPAIR_BRANCH: repairBranch,
        IVA_REPAIR_SKIP_RESTART: "1",
      },
    });

    assert.equal(git(install, "rev-parse", "HEAD"), target);
    assert.equal(
      readFileSync(join(install, ".env"), "utf8"),
      "IVA_PORT=8723\n",
    );
    assert.equal(
      readFileSync(join(install, "data/settings.json"), "utf8"),
      '{"saved":true}\n',
    );
    assert.equal(
      readFileSync(join(install, ".workflow-data/run.json"), "utf8"),
      '{"run":1}\n',
    );
    assert.equal(
      readFileSync(join(install, ".eve/.workflow-data/eve.json"), "utf8"),
      '{"eve":1}\n',
    );
    assert.equal(
      readFileSync(join(install, "scripts/custom-telegram-button.ts"), "utf8"),
      "export const customButton = true;\n",
    );
    assert.equal(
      readFileSync(join(install, "agent/skills/my-skill/SKILL.md"), "utf8"),
      "# Mine\n",
    );
    assert.match(
      readFileSync(join(install, "agent/channels/eve.ts"), "utf8"),
      /local compatible change/,
    );
    assert.equal(
      readFileSync(join(install, "docs/index.html"), "utf8"),
      execFileSync("git", ["show", "HEAD:docs/index.html"], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    );
    assert.match(output, /Iva is repaired and updated\./);
    const backup = output.match(/Your complete backup: (.+)/)?.[1];
    assert.ok(backup);
    assert.equal(
      readFileSync(join(backup, "docs/index.html"), "utf8"),
      "<html>local docs</html>\n",
    );
    assert.equal(
      readFileSync(join(backup, "scripts/telegram-poll.mjs"), "utf8"),
      "// local Telegram buttons\n",
    );
    const conflicts = readFileSync(
      join(
        install,
        "data/update-recovery",
        readdirSync(join(install, "data/update-recovery"))[0],
        "conflicts.txt",
      ),
      "utf8",
    );
    assert.match(conflicts, /docs\/index\.html/);
    assert.match(conflicts, /scripts\/telegram-poll\.mjs/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("repair falls back to clean core when customized dependencies fail", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-shell-fallback-"));
  const remote = join(fixture, "remote.git");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  const npmState = join(fixture, "npm-state");
  try {
    const target = git(ROOT, "rev-parse", "HEAD");
    const repairBranch = "repair-test-target";
    execFileSync("git", ["clone", "--quiet", "--bare", ROOT, remote]);
    execFileSync(
      "git",
      ["--git-dir", remote, "update-ref", `refs/heads/${repairBranch}`, target],
      { cwd: ROOT },
    );
    execFileSync("git", ["clone", "--quiet", remote, install]);
    assert.doesNotThrow(
      () => git(install, "cat-file", "-e", `${LEGACY_HEAD}^{commit}`),
      `LEGACY_HEAD ${LEGACY_HEAD} is unreachable; run the test on a full clone`,
    );
    git(install, "checkout", "-B", "main", LEGACY_HEAD);
    writeFileSync(
      join(install, "scripts/custom-telegram-button.ts"),
      "export const customButton = true;\n",
    );
    mkdirSync(join(install, "data"), { recursive: true });
    writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');

    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nset -eu\nstate=${IVA_TEST_NPM_STATE:?}\nif [ "$1" = "ci" ]; then printf "ci\\n" >> "$state.log"; if [ ! -e "$state.failed" ]; then : > "$state.failed"; exit 1; fi; exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then printf "build\\n" >> "$state.log"; mkdir -p .output/server; printf ok > .output/server/index.mjs; fi\n',
    );
    chmodSync(fakeNpm, 0o755);

    const output = execFileSync("bash", [join(ROOT, "repair.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: install,
        IVA_REPAIR_REPO_URL: remote,
        IVA_REPAIR_BRANCH: repairBranch,
        IVA_REPAIR_SKIP_RESTART: "1",
        IVA_TEST_NPM_STATE: npmState,
      },
    });

    assert.equal(git(install, "rev-parse", "HEAD"), target);
    assert.equal(
      readFileSync(join(install, "data/settings.json"), "utf8"),
      '{"saved":true}\n',
    );
    assert.throws(
      () => readFileSync(join(install, "scripts/custom-telegram-button.ts")),
      { code: "ENOENT" },
    );
    assert.equal(readFileSync(`${npmState}.log`, "utf8"), "ci\nci\nbuild\n");
    const backup = output.match(/Your complete backup: (.+)/)?.[1];
    assert.ok(backup);
    assert.equal(
      readFileSync(join(backup, "scripts/custom-telegram-button.ts"), "utf8"),
      "export const customButton = true;\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("repair refuses a versioned install and names the commands that fit it", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-versioned-"));
  try {
    const install = join(fixture, "iva");
    mkdirSync(join(install, "versions/0.3.15-0123456789ab"), {
      recursive: true,
    });
    const result = execFileSync("bash", [join(ROOT, "repair.sh")], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, IVA_INSTALL_DIR: install },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail(`repair.sh should have refused: ${result}`);
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(String(failure.stderr), /iva update.*iva rollback/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
