// Brain настоящим процессом: коммит незакоммиченного, граф ссылок, Alert о длинном CORE
// через шов Notice (без чата — строкой в журнал) и бэкап: remote, приватный remote через
// авторизованный gh, отказ с Alert без gh и при неудачном push.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

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
  // .gitignore установки из шаблона: граф - производные данные, git его не берёт.
  copyFileSync(
    join(ROOT, "vault-template/.gitignore"),
    join(vault, ".gitignore"),
  );
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "brain@example.invalid");
  git(vault, "config", "user.name", "Brain");
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", "initial");
  const bare = join(root, "backup.git");
  git(root, "init", "-q", "--bare", bare);
  git(vault, "remote", "add", "origin", bare);
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
  assert.equal(git(vault, "ls-files", ".graph"), "");
  assert.match(git(vault, "log", "--format=%s"), /brain: owner changes/u);
  assert.equal(git(bare, "rev-parse", "HEAD"), git(vault, "rev-parse", "HEAD"));
});

/** vault под git, data и каталог bin для двойника gh; Brain — настоящим процессом. */
function brainFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "iva-brain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [vault, data, bin] = ["vault", "data", "bin"].map((d) => join(root, d));
  for (const dir of [join(vault, "cards"), data, bin])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(vault, "cards/a.md"), "# A\n");
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "brain@example.invalid");
  git(vault, "config", "user.name", "Brain");
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", "initial");
  const gh = (script: string) => {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  };
  const brain = () =>
    spawnSync(
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
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ASSISTANT_VAULT_DIR: vault,
          ASSISTANT_DATA_DIR: data,
          TELEGRAM_BOT_TOKEN: "",
          TELEGRAM_DIGEST_CHAT_ID: "",
          TELEGRAM_ALLOWED_USER_IDS: "",
        },
      },
    );
  return { root, vault, gh, brain };
}

void test("Brain без origin и без входа gh: отказ и Alert с действием владельца (#13)", (t) => {
  const fx = brainFixture(t);
  fx.gh("exit 1");
  const run = fx.brain();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /brain alert: .*gh auth login/u);
});

void test("Brain без origin с авторизованным gh: приватный iva-vault и push (#13)", (t) => {
  const fx = brainFixture(t);
  const bare = join(fx.root, "iva-vault.git");
  const log = join(fx.root, "gh.log");
  fx.gh(
    [
      `echo "$@" >> ${log}`,
      'if [ "$1 $2" = "repo create" ]; then',
      `  git init -q --bare ${bare} && git -C "$6" remote add origin ${bare} && git -C "$6" push -q origin HEAD`,
      "fi",
      "exit 0",
    ].join("\n"),
  );
  const run = fx.brain();
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    readFileSync(log, "utf8"),
    /repo create iva-vault --private --source/u,
  );
  assert.equal(
    git(bare, "rev-parse", "HEAD"),
    git(fx.vault, "rev-parse", "HEAD"),
  );
});

void test("Brain: push не ушёл — код 1 и Alert о бэкапе", (t) => {
  const fx = brainFixture(t);
  git(fx.vault, "remote", "add", "origin", join(fx.root, "нет.git"));
  const run = fx.brain();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /brain alert: Бэкап vault не ушёл/u);
});

/** gh-двойник: create отказывает (репозиторий есть), view отвечает видимостью. */
function existingRepo(fx: ReturnType<typeof brainFixture>, visibility: string) {
  const log = join(fx.root, "gh.log");
  fx.gh(
    [
      `echo "$@" >> ${log}`,
      'case "$1 $2" in',
      '  "repo create") exit 1 ;;',
      '  "api user") echo tester ;;',
      `  "repo view") echo ${visibility} ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
  );
  // github.com-адрес уходит в локальный bare-репозиторий: сети нет.
  const bare = join(fx.root, "iva-vault.git");
  git(fx.root, "init", "-q", "--bare", bare);
  git(
    fx.vault,
    "config",
    `url.${fx.root}/.insteadOf`,
    "https://github.com/tester/",
  );
  return { bare, log };
}

void test("Brain: уже существующий iva-vault публичный — remote не добавлен, push нет, Alert (r3 #1)", (t) => {
  const fx = brainFixture(t);
  const { bare } = existingRepo(fx, "PUBLIC");
  const run = fx.brain();
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /brain alert: .*tester\/iva-vault.*не приватный/u);
  assert.equal(
    spawnSync("git", ["remote", "get-url", "origin"], { cwd: fx.vault }).status,
    2,
  );
  assert.equal(git(bare, "rev-list", "--all", "--count"), "0");
});

void test("Brain: уже существующий iva-vault приватный — origin привязан и push ушёл (r3 #1)", (t) => {
  const fx = brainFixture(t);
  const { bare, log } = existingRepo(fx, "PRIVATE");
  const run = fx.brain();
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    readFileSync(log, "utf8"),
    /repo view tester\/iva-vault --json visibility/u,
  );
  assert.equal(
    git(bare, "rev-parse", "HEAD"),
    git(fx.vault, "rev-parse", "HEAD"),
  );
});

// Язык владельца, как в v0.4.8 (noticeTranslator): settings.language=en — Alert
// по-английски, каждый из трёх.
void test("Brain говорит с владельцем на его языке: без origin, неудачный push и длинный CORE", (t) => {
  const fx = brainFixture(t);
  fx.gh("exit 1");
  const data = join(fx.root, "data");
  writeFileSync(join(data, "settings.json"), '{"language":"en"}\n');
  writeFileSync(join(fx.vault, "CORE.md"), `# CORE\n\n- ${"x".repeat(5000)}\n`);
  const noRemote = fx.brain();
  assert.match(
    noRemote.stderr,
    /brain alert: Memory is not backed up: the vault has no git remote\./u,
  );
  assert.match(noRemote.stderr, /brain alert: CORE\.md is longer than/u);
  git(fx.vault, "remote", "add", "origin", join(fx.root, "нет.git"));
  const failed = fx.brain();
  assert.match(failed.stderr, /brain alert: The vault backup did not reach/u);
  assert.doesNotMatch(noRemote.stderr + failed.stderr, /[а-яё]{4}/iu);
});
