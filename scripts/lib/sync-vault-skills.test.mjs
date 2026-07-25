import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncVaultSkills } from "./sync-vault-skills.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sync-skills-"));
  const templateDir = join(root, "vault-template");
  const vaultDir = join(root, "vault");
  const src = join(templateDir, ".claude/skills/autograph/scripts");
  const dst = join(vaultDir, ".claude/skills/autograph/scripts");
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  return { root, templateDir, vaultDir, src, dst };
}

test("outdated script is overwritten, identical one is not reported", () => {
  const { root, templateDir, vaultDir, src, dst } = setup();
  writeFileSync(join(src, "common.py"), "print('fixed')\n");
  writeFileSync(join(dst, "common.py"), "print('buggy')\n");
  writeFileSync(join(src, "same.py"), "same\n");
  writeFileSync(join(dst, "same.py"), "same\n");

  const { updated } = syncVaultSkills({ vaultDir, templateDir });
  assert.deepEqual(updated, ["autograph/scripts/common.py"]);
  assert.equal(readFileSync(join(dst, "common.py"), "utf8"), "print('fixed')\n");
  rmSync(root, { recursive: true, force: true });
});

test("new script is created, user data and schema are untouched", () => {
  const { root, templateDir, vaultDir, src } = setup();
  writeFileSync(join(src, "new.py"), "new\n");
  writeFileSync(join(templateDir, ".claude/skills/autograph", "schema.json"), "{}");
  writeFileSync(join(vaultDir, "CORE.md"), "user data");

  const { updated } = syncVaultSkills({ vaultDir, templateDir });
  assert.deepEqual(updated, ["autograph/scripts/new.py"]);
  assert.equal(existsSync(join(vaultDir, ".claude/skills/autograph/schema.json")), false);
  assert.equal(readFileSync(join(vaultDir, "CORE.md"), "utf8"), "user data");
  rmSync(root, { recursive: true, force: true });
});

test("stale __pycache__ is dropped on sync", () => {
  const { root, templateDir, vaultDir, src, dst } = setup();
  writeFileSync(join(src, "common.py"), "v2\n");
  writeFileSync(join(dst, "common.py"), "v1\n");
  mkdirSync(join(dst, "__pycache__"));
  writeFileSync(join(dst, "__pycache__", "common.cpython-312.pyc"), "stale");

  syncVaultSkills({ vaultDir, templateDir });
  assert.equal(existsSync(join(dst, "__pycache__")), false);
  rmSync(root, { recursive: true, force: true });
});

test("missing vault or template is a no-op", () => {
  const { root, templateDir, vaultDir } = setup();
  assert.deepEqual(syncVaultSkills({ vaultDir: join(root, "nope"), templateDir }).updated, []);
  assert.deepEqual(syncVaultSkills({ vaultDir, templateDir: join(root, "nope") }).updated, []);
  rmSync(root, { recursive: true, force: true });
});
