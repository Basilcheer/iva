import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const INIT_VAULT = fileURLToPath(new URL("./init-vault.mjs", import.meta.url));

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iva-init-vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeTemplate(root: string) {
  const template = join(root, "vault-template");
  mkdirSync(join(template, "cards"), { recursive: true });
  writeFileSync(join(template, "CORE.md"), "Russian core\n");
  writeFileSync(join(template, "CORE.en.md"), "English core\n");
  writeFileSync(join(template, "MOC.md"), "MOC\n");
  writeFileSync(join(template, "cards", ".gitkeep"), "");
}

function withoutGitIdentity(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  delete env.GIT_CONFIG_GLOBAL;
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(root, "empty-home"),
    XDG_CONFIG_HOME: join(root, "empty-xdg"),
  };
}

function runInit(root: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [INIT_VAULT], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

void test("init-vault rejects a missing template before creating a vault", async (t) => {
  const root = await sandbox(t);
  const result = runInit(root, {
    ...process.env,
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /template .* not found/u);
  assert.equal(existsSync(join(root, "live-vault")), false);
});

void test("init-vault creates the Russian template and continues without Git identity", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const result = runInit(root, {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  });
  const vault = join(root, "live-vault");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vault created from template/u);
  assert.match(result.stderr, /first commit failed/u);
  assert.equal(readFileSync(join(vault, "CORE.md"), "utf8"), "Russian core\n");
  assert.equal(existsSync(join(vault, "CORE.en.md")), false);
  assert.equal(readFileSync(join(vault, "MOC.md"), "utf8"), "MOC\n");
  assert.equal(existsSync(join(vault, ".git")), true);
});

void test("init-vault selects English CORE when requested", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const result = runInit(root, {
    ...withoutGitIdentity(root),
    AGENT_LANGUAGE: "en",
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, "live-vault", "CORE.md"), "utf8"),
    "English core\n",
  );
  assert.equal(existsSync(join(root, "live-vault", "CORE.en.md")), false);
});

void test("init-vault preserves an existing vault on repeated runs", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const env = {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  };
  const first = runInit(root, env);
  const vault = join(root, "live-vault");
  writeFileSync(join(vault, "personal.md"), "keep this\n");
  const second = runInit(root, env);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /vault already has data, skipping template copy/u);
  assert.equal(readFileSync(join(vault, "personal.md"), "utf8"), "keep this\n");
  assert.equal(existsSync(join(vault, "CORE.en.md")), false);
});

void test("init-vault leaves a non-empty pre-existing vault untouched", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const vault = join(root, "live-vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "personal.md"), "private memory\n");

  const result = runInit(root, {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vault already has data, skipping template copy/u);
  assert.equal(readFileSync(join(vault, "personal.md"), "utf8"), "private memory\n");
  assert.equal(existsSync(join(vault, "CORE.md")), false);
  assert.equal(existsSync(join(vault, ".git")), true);
  assert.equal(
    execFileSync("git", ["-C", vault, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).trim(),
    "true",
  );
});
