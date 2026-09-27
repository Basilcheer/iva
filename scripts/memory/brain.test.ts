// Brain настоящим процессом: коммит незакоммиченного, граф ссылок, Alert о длинном CORE
// через шов Notice (без чата — строкой в журнал) и бэкап без remote.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

void test("Brain коммитит правку владельца, строит граф и говорит о длинном CORE", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-brain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [vault, data] = [join(root, "vault"), join(root, "data")];
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(vault, "cards/a.md"), "# A\n\n[[cards/b]]\n");
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "brain@example.invalid");
  git(vault, "config", "user.name", "Brain");
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", "initial");
  writeFileSync(join(vault, "cards/b.md"), "# B\n");
  writeFileSync(join(vault, "CORE.md"), `# CORE\n\n- ${"x".repeat(5000)}\n`);
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      join(ROOT, "scripts/lib/ts-esm-hooks.ts"),
      join(ROOT, "scripts/memory/brain.ts"),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: data,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_DIGEST_CHAT_ID: "",
        TELEGRAM_ALLOWED_USER_IDS: "",
      },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /brain alert: CORE\.md длиннее/u);
  assert.equal(git(vault, "status", "--porcelain"), "");
  assert.ok(existsSync(join(vault, ".graph/vault-graph.json")));
  assert.match(git(vault, "log", "--format=%s"), /brain: owner changes/u);
});
