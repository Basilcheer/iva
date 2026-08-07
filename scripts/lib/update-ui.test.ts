/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- legacy Node test registration and dynamic JavaScript bridge fixtures */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSummary } from "./model-summary.ts";
import { createTerminalProgress } from "./progress.ts";
import {
  createTelegramUpdateReporter,
  UPDATE_LOADER,
} from "./telegram-status.ts";
import {
  acquireUpdateLock,
  createUpdateTransaction,
  releaseUpdateLock,
} from "./update-safety.ts";

type TelegramBody = {
  message_id?: number;
  text?: string;
  entities?: { custom_emoji_id?: string }[];
  reply_markup?: {
    inline_keyboard: { text?: string; callback_data: string }[][];
  };
};
type TelegramCall = { method: string | undefined; body: TelegramBody };
type MockResponse = {
  ok: boolean;
  status: number;
  json(): Promise<{
    ok?: boolean;
    result?: unknown;
    description?: string;
    parameters?: { retry_after?: number };
  }>;
};
type MockFetch = (url: string, init: { body: string }) => Promise<MockResponse>;
const mutableGlobal = globalThis as unknown as { fetch: MockFetch };

test("modelSummary uses configured provider values without runtime defaults", () => {
  assert.deepEqual(
    modelSummary({
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "gpt-5.5",
      CODEX_CONTEXT_WINDOW: "272000",
    }),
    {
      provider: "OpenAI",
      model: "gpt-5.5",
      contextWindow: 272000,
      line: "OpenAI · gpt-5.5",
    },
  );
});

test("terminal progress is deterministic outside a TTY", () => {
  let output = "";
  const stream = {
    isTTY: false,
    write: (chunk: string) => {
      output += chunk;
    },
  };
  const progress = createTerminalProgress({ stream, env: {} });
  progress.start("Saving changes");
  progress.done("Changes saved");
  progress.dispose();
  assert.equal(output, "◇ Saving changes\n✓ Changes saved\n");
});

test("terminal progress restores the cursor when disposed", () => {
  let output = "";
  const stream = {
    isTTY: true,
    write: (chunk: string) => {
      output += chunk;
    },
  };
  const progress = createTerminalProgress({
    stream,
    env: { TERM: "xterm" },
    intervalMs: 60_000,
  });
  progress.start("Building");
  progress.dispose();
  // eslint-disable-next-line no-control-regex -- The assertion verifies the ANSI hide-cursor sequence.
  assert.match(output, /\x1b\[\?25l/);
  // eslint-disable-next-line no-control-regex -- The assertion verifies the ANSI show-cursor sequence.
  assert.match(output, /\x1b\[\?25h/);
});

test("Telegram update edits one message through every phase and final result", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.done("protect");
  await reporter.start("fetch");
  await reporter.done("fetch");
  await reporter.start("build");
  await reporter.done("build");
  await reporter.complete({
    beforeVersion: "v1",
    afterVersion: "v2",
    changedLocal: true,
  });
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 4);
  assert.deepEqual(
    edits.map((call) => call.body.message_id),
    [100, 100, 100, 100],
  );
  assert.deepEqual(
    edits.slice(0, 3).map((call) => call.body.entities?.[0]?.custom_emoji_id),
    [
      UPDATE_LOADER.customEmojiId,
      UPDATE_LOADER.customEmojiId,
      UPDATE_LOADER.customEmojiId,
    ],
  );
  assert.deepEqual(
    edits.slice(0, 3).map((call) => call.body.text),
    [
      `${UPDATE_LOADER.alt} Сохраняю ваши изменения`,
      `${UPDATE_LOADER.alt} Получаю обновление`,
      `${UPDATE_LOADER.alt} Собираю Iva`,
    ],
  );
  assert.match(edits[3]?.body.text ?? "", /Iva обновлена/);
  assert.match(edits[3]?.body.text ?? "", /OpenAI · gpt-5.5/);
  assert.equal(edits[3].body.entities, undefined);
});

test("Telegram reports a successful core update when local files conflict", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.complete({
    beforeVersion: "v0.3.13",
    afterVersion: "v0.3.13",
    changedLocal: true,
    restoreReport: {
      status: "conflicted",
      stashOid: "abc",
      recoveryDir:
        "/srv/iva/data/update-conflicts/2026-08-06T12-00-00-000Z-deadbeef1234",
      conflicts: [
        {
          path: "docs/index.html",
          baseMode: "100644",
          localMode: "100644",
          upstreamMode: "100644",
        },
        {
          path: "docs/ru/index.html",
          baseMode: "100644",
          localMode: "100644",
          upstreamMode: "100644",
        },
      ],
    },
  });

  const final = calls.at(-1)?.body;
  assert.match(final?.text ?? "", /✅ Iva обновлена/);
  assert.match(final?.text ?? "", /Новое ядро активно/);
  assert.doesNotMatch(final?.text ?? "", /Не удалось собрать/);
  assert.equal(
    final?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data,
    "iva_update:conflicts:2026-08-06T12-00-00-000Z-deadbeef1234",
  );
});

test("Telegram does not recreate phase messages after the active message was deleted", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText") {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: message to edit not found",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 200 } }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.start("fetch");
  await reporter.start("build");
  await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" });
  reporter.dispose();
  assert.equal(
    calls.filter((call) => call.method === "sendMessage").length,
    1,
    "only the final result is recreated",
  );
});

test("Telegram retries 429 without downgrading the custom emoji and deduplicates phase edits", async () => {
  const calls: TelegramCall[] = [];
  let first = true;
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    if (first) {
      first = false;
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, parameters: { retry_after: 1 } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.start("protect");
  await reporter.done("protect");
  await reporter.done("protect");
  reporter.dispose();
  assert.equal(calls.length, 2, "one retry and no duplicate edit");
  assert.ok(
    calls.every(
      (call) =>
        call.body.entities?.[0].custom_emoji_id === UPDATE_LOADER.customEmojiId,
    ),
  );
});

test("Telegram falls back to a simple Unicode marker when custom emoji is unavailable", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    if (body.entities) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: custom emoji entities are not allowed",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.start("fetch");
  reporter.dispose();

  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.entities);
  assert.equal(
    calls[1].body.text,
    `${UPDATE_LOADER.fallback} Saving your changes`,
  );
  assert.equal(
    calls[2].body.text,
    `${UPDATE_LOADER.fallback} Getting the update`,
  );
  assert.equal(calls[1].body.entities, undefined);
  assert.equal(calls[2].body.entities, undefined);
});

test("Telegram preserves error-like status when selecting the custom emoji fallback", async () => {
  const calls: TelegramCall[] = [];
  const telegramError = {
    message: "Bad Request: custom emoji entities are not allowed",
    status: 400,
  };
  const fetchImpl: MockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Telegram adapters may reject with a structural API error instead of an Error instance
    if (body.entities) throw telegramError;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);
  await reporter.start("protect");
  reporter.dispose();

  assert.equal(calls.length, 4);
  assert.ok(calls.slice(0, 3).every((call) => call.body.entities));
  assert.equal(calls[3].body.entities, undefined);
  assert.equal(
    calls[3].body.text,
    `${UPDATE_LOADER.fallback} Saving your changes`,
  );
});

test("Telegram update failure replaces the active phase in the same message", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.fail("fetch", "v1");
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  assert.deepEqual(
    calls.map((call) => call.body.message_id),
    [100, 100],
  );
  assert.match(calls[1]?.body.text ?? "", /Couldn't get the update/);
  assert.match(calls[1]?.body.text ?? "", /still running v1/);
});

test("update callback is acknowledged before any message edit", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls: string[] = [];
  mutableGlobal.fetch = async (url) => {
    calls.push(url.split("/").at(-1) ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?test=${Date.now()}`);
    await bridge.handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      data: "iva_update:skip",
      message: { chat: { id: 1 }, message_id: 2 },
    });
    assert.deepEqual(calls, ["answerCallbackQuery", "editMessageText"]);
    assert.deepEqual(
      bridge.resetMessageCopy(
        "/new",
        {
          MODEL_PROVIDER: "codex",
          CODEX_MODEL: "gpt-5.5",
          CODEX_CONTEXT_WINDOW: "272000",
        },
        "ru",
      ),
      {
        pending: "◇ Начинаю новый диалог",
        complete:
          "✨ Новый диалог готов\n\nМодель: OpenAI · gpt-5.5\nКонтекст очищен · окно 272k",
      },
    );
  } finally {
    mutableGlobal.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("up-to-date check shows the model from fresh .env, not this process's snapshot", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousEnv = Object.fromEntries(
    [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "MODEL_PROVIDER",
      "OPENCODE_MODEL",
    ].map((k) => [k, process.env[k]]),
  );
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  // The bridge's snapshot is stale: the /model wizard rewrote .env after this process started.
  process.env.MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_MODEL = "stale-model";
  const calls: TelegramCall[] = [];
  mutableGlobal.fetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 10 } }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?fresh=${Date.now()}`);
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: false,
        localVersion: "1.2.3",
      }),
      envImpl: async () => ({
        MODEL_PROVIDER: "codex",
        CODEX_MODEL: "fresh-model",
      }),
    });
    const edit = calls.find((call) => call.method === "editMessageText");
    assert.match(edit?.body.text ?? "", /OpenAI · fresh-model/);
  } finally {
    mutableGlobal.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("manual update offer keeps commit-based behavior and marks a stable release as shown", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls: TelegramCall[] = [];
  mutableGlobal.fetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result:
          method === "sendMessage" ? { message_id: 10 } : { message_id: 10 },
      }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?manual=${Date.now()}`);
    const marked: string[] = [];
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: true,
        hasVersionUpdate: true,
        localVersion: "1.2.3",
        remoteVersion: "1.2.4",
      }),
      markNotifiedImpl: async (_dataDir: string, version: string) =>
        marked.push(version),
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "editMessageText"],
    );
    assert.equal(calls[1]?.body.reply_markup?.inline_keyboard[0]?.length, 2);
    assert.deepEqual(marked, ["1.2.4"]);
  } finally {
    mutableGlobal.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("update lock is exclusive and owner-reentrant", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-lock-"));
  const first = acquireUpdateLock(dir, "one");
  assert.equal(first.ok, true);
  assert.equal(acquireUpdateLock(dir, "one").ok, true);
  assert.equal(acquireUpdateLock(dir, "two").ok, false);
  releaseUpdateLock(first);
  assert.equal(acquireUpdateLock(dir, "two").ok, true);
});

test("verified update commits before timer activation and contains a timer failure", async () => {
  const updateSafety = await import("./update-safety.ts");
  assert.equal(typeof updateSafety.commitThenRunPostCommit, "function");

  const calls: string[] = [];
  const timerError = new Error("timer activation failed");
  const result = await updateSafety.commitThenRunPostCommit({
    commit: async () => {
      calls.push("commit");
    },
    postCommit: async () => {
      calls.push("timer");
      throw timerError;
    },
  });

  assert.deepEqual(calls, ["commit", "timer"]);
  assert.deepEqual(result, { ok: false, error: timerError });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureGit(cwd: string): void {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Iva Test");
}

test("safe update preserves staged, unstaged and untracked user files", async () => {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(join(seed, ".gitignore"), ".env\n.output\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);

  writeFileSync(join(seed, "upstream.txt"), "upstream\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.1.0" }),
  );
  git(seed, "add", ".");
  git(seed, "commit", "-m", "upstream");
  git(seed, "push", "origin", "main");

  writeFileSync(join(local, "tracked.txt"), "user change\n");
  git(local, "add", "tracked.txt");
  writeFileSync(join(local, "unstaged.txt"), "unstaged\n");
  writeFileSync(join(local, "custom-skill.txt"), "custom\n");
  writeFileSync(join(local, ".env"), "SECRET=kept\n", { mode: 0o600 });
  mkdirSync(data, { recursive: true });
  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "update.log"),
  });
  await tx.protect();
  const result = await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(result.changed, true);
  assert.equal(
    readFileSync(join(local, "tracked.txt"), "utf8"),
    "user change\n",
  );
  assert.equal(readFileSync(join(local, "unstaged.txt"), "utf8"), "unstaged\n");
  assert.equal(
    readFileSync(join(local, "custom-skill.txt"), "utf8"),
    "custom\n",
  );
  assert.equal(readFileSync(join(local, ".env"), "utf8"), "SECRET=kept\n");
  assert.equal(readFileSync(join(local, "upstream.txt"), "utf8"), "upstream\n");
  assert.match(git(local, "status", "--porcelain=v1"), /^M {2}tracked\.txt/m);
  await tx.commit();
  assert.equal(git(local, "stash", "list"), "");
});

test("safe update migrates a merged legacy branch to the main channel", async () => {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-channel-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "branch", "feat/legacy");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main", "feat/legacy");
  git(temp, "clone", "--branch", "feat/legacy", remote, local);
  configureGit(local);

  writeFileSync(join(seed, "upstream.txt"), "main update\n");
  git(seed, "add", "upstream.txt");
  git(seed, "commit", "-m", "main update");
  git(seed, "push", "origin", "main");
  const expected = git(seed, "rev-parse", "HEAD");

  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
  await tx.protect();
  const update = await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(update.legacyMigration, true);
  assert.equal(update.branch, "main");
  assert.equal(git(local, "rev-parse", "HEAD"), expected);
  await tx.commit();
  assert.equal(
    git(local, "config", "--local", "--get", "iva.updateBranch"),
    "main",
  );
});

function updateFixture() {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-failure-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(join(seed, ".gitignore"), ".env\n.output\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);
  mkdirSync(data, { recursive: true });
  return { temp, remote, seed, local, data };
}

test("stash conflict report can still roll back user files byte-for-byte", async () => {
  const { temp, seed, local, data } = updateFixture();
  const originalHead = git(local, "rev-parse", "HEAD");
  writeFileSync(join(local, "tracked.txt"), "user version\n");
  writeFileSync(join(local, "custom.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(local, ".env"), "SECRET=before\n", { mode: 0o600 });
  mkdirSync(join(local, ".output"));
  writeFileSync(join(local, ".output", "server"), "old build");

  writeFileSync(join(seed, "tracked.txt"), "upstream version\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "conflicting upstream");
  git(seed, "push", "origin", "main");

  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
  await tx.protect();
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "conflicted");
  tx.backupOutput();
  mkdirSync(join(local, ".output"));
  writeFileSync(join(local, ".output", "server"), "bad build");
  writeFileSync(join(local, ".env"), "SECRET=changed\n");
  await tx.rollback();

  assert.equal(git(local, "rev-parse", "HEAD"), originalHead);
  assert.equal(
    readFileSync(join(local, "tracked.txt"), "utf8"),
    "user version\n",
  );
  assert.deepEqual(
    readFileSync(join(local, "custom.bin")),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal(readFileSync(join(local, ".env"), "utf8"), "SECRET=before\n");
  assert.equal(
    readFileSync(join(local, ".output", "server"), "utf8"),
    "old build",
  );
  assert.notEqual(
    git(local, "stash", "list"),
    "",
    "protective stash is retained after rollback",
  );
  assert.equal(existsSync(join(local, ".output.iva-backup")), false);
});

test("conflicting local commits abort rebase and restore the original branch", async () => {
  const { temp, seed, local, data } = updateFixture();
  writeFileSync(join(local, "tracked.txt"), "local commit\n");
  git(local, "add", "tracked.txt");
  git(local, "commit", "-m", "local");
  const originalHead = git(local, "rev-parse", "HEAD");
  writeFileSync(join(seed, "tracked.txt"), "upstream commit\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "upstream");
  git(seed, "push", "origin", "main");
  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
  await tx.protect();
  await assert.rejects(() => tx.fetchAndIntegrate(), /local commits conflict/);
  await tx.rollback();
  assert.equal(git(local, "rev-parse", "HEAD"), originalHead);
  assert.equal(
    readFileSync(join(local, "tracked.txt"), "utf8"),
    "local commit\n",
  );
  assert.equal(git(local, "status", "--porcelain=v1"), "");
});

// --- Worktree-кандидат апдейта (buildCandidate/promoteCandidate) ---------------------------

const FAKE_BUILD =
  "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
  "f.writeFileSync('.output/server/marker.txt',f.readFileSync('tracked.txt','utf8').trim())\"";

type CandidateFixture = {
  temp: string;
  remote: string;
  seed: string;
  local: string;
  data: string;
};

function candidateFixture({
  buildScript = FAKE_BUILD,
}: { buildScript?: string } = {}): CandidateFixture {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-candidate-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(
    join(seed, ".gitignore"),
    ".env\n.output\n/.iva-update/\nnode_modules\n",
  );
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { build: buildScript },
    }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);
  mkdirSync(data, { recursive: true });
  mkdirSync(join(local, ".output/server"), { recursive: true });
  writeFileSync(join(local, ".output/server/marker.txt"), "live");
  mkdirSync(join(local, "node_modules"), { recursive: true });
  return { temp, remote, seed, local, data };
}

function pushUpstream(
  seed: string,
  mutate: (seed: string) => void,
  message: string,
): string {
  mutate(seed);
  git(seed, "add", ".");
  git(seed, "commit", "-m", message);
  git(seed, "push", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

function candidateTx({ local, temp, data }: CandidateFixture) {
  return createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
}

test("update candidate builds in a worktree and is promoted after a clean fast-forward", async () => {
  const fx = candidateFixture();
  const target = pushUpstream(
    fx.seed,
    (seed) => {
      writeFileSync(join(seed, "tracked.txt"), "v2\n");
    },
    "bump",
  );
  const tx = candidateTx(fx);
  await tx.protect();
  const update = await tx.resolveTarget();
  assert.equal(update.plan, "fast-forward");
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate, "clean fast-forward must produce a candidate");
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "live",
  );
  await tx.fetchAndIntegrate();
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "v2",
  );
  assert.equal(existsSync(join(fx.local, ".iva-update")), false);
  assert.equal(git(fx.local, "stash", "list"), "");
  assert.equal(git(fx.local, "worktree", "list").split("\n").length, 1);
});

test("dirty update activates the new build and archives conflicting HTML", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',f.readFileSync('agent.txt','utf8').trim())\"",
  });
  writeFileSync(join(fx.seed, "agent.txt"), "stock agent\n");
  mkdirSync(join(fx.seed, "docs/ru"), { recursive: true });
  writeFileSync(join(fx.seed, "docs/index.html"), "stock en\n");
  writeFileSync(join(fx.seed, "docs/ru/index.html"), "stock ru\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "add authored fixture");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");

  writeFileSync(join(fx.local, "agent.txt"), "local agent\n");
  writeFileSync(join(fx.local, "docs/index.html"), "local en\n");
  writeFileSync(join(fx.local, "docs/ru/index.html"), "local ru\n");
  const target = pushUpstream(
    fx.seed,
    (seed) => {
      writeFileSync(join(seed, "docs/index.html"), "upstream en\n");
      writeFileSync(join(seed, "docs/ru/index.html"), "upstream ru\n");
    },
    "update core and docs",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate, "dirty fast-forward must still produce a candidate");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "conflicted");
  assert.deepEqual(
    restored.conflicts.map(({ path }) => path),
    ["docs/index.html", "docs/ru/index.html"],
  );
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "local agent",
  );
  assert.equal(
    readFileSync(join(fx.local, "docs/index.html"), "utf8"),
    "upstream en\n",
  );
  assert.equal(
    readFileSync(join(fx.local, "docs/ru/index.html"), "utf8"),
    "upstream ru\n",
  );
  assert.equal(
    readFileSync(join(restored.recoveryDir, "base/docs/index.html"), "utf8"),
    "stock en\n",
  );
  assert.equal(
    readFileSync(join(restored.recoveryDir, "local/docs/index.html"), "utf8"),
    "local en\n",
  );
  assert.equal(
    readFileSync(
      join(restored.recoveryDir, "upstream/docs/index.html"),
      "utf8",
    ),
    "upstream en\n",
  );
  assert.equal(existsSync(join(restored.recoveryDir, "changes.patch")), true);
  assert.equal(existsSync(join(restored.recoveryDir, "report.json")), true);
  assert.notEqual(
    git(fx.local, "stash", "list"),
    "",
    "a recovery stash is retained until the user resolves the conflict",
  );
  assert.doesNotMatch(
    git(fx.local, "status", "--porcelain=v1"),
    /^(UU|AA|DD|AU|UA|DU|UD) /m,
  );
});

test("a broken local customization falls back to the verified new core", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');const v=f.readFileSync('agent.txt','utf8').trim();" +
      "if(v==='broken local'){process.exit(1)}f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',v)\"",
  });
  writeFileSync(join(fx.seed, "agent.txt"), "stock agent\n");
  git(fx.seed, "add", "agent.txt");
  git(fx.seed, "commit", "-m", "add agent fixture");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  writeFileSync(join(fx.local, "agent.txt"), "broken local\n");
  const target = pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "upstream.txt"), "new core\n"),
    "update core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "fallback");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.ok(restored.status === "preserved");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, "agent.txt"), "utf8"),
    "stock agent\n",
  );
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "stock agent",
  );
  assert.equal(
    JSON.parse(readFileSync(join(restored.recoveryDir, "report.json"), "utf8"))
      .reason,
    "custom-build-failed",
  );
  assert.notEqual(git(fx.local, "stash", "list"), "");
});

test("broken candidate build aborts before the live checkout is touched", async () => {
  const fx = candidateFixture();
  pushUpstream(
    fx.seed,
    (seed) => {
      const pkg = JSON.parse(readFileSync(join(seed, "package.json"), "utf8"));
      pkg.version = "1.1.0";
      pkg.scripts.build = 'node -e "process.exit(1)"';
      writeFileSync(join(seed, "package.json"), JSON.stringify(pkg));
    },
    "broken build",
  );
  const baseline = git(fx.local, "rev-parse", "HEAD");
  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  await assert.rejects(
    () => tx.buildCandidate({ npm: "npm" }),
    /candidate build failed/,
  );
  assert.equal(tx.outputTouched, false);
  await tx.rollback();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), baseline);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "live",
  );
  assert.equal(existsSync(join(fx.local, ".iva-update")), false);
});

test("changed lockfile installs candidate dependencies and promotes fresh node_modules", async () => {
  const fx = candidateFixture();
  const npmLock = (cwd: string) =>
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--no-audit", "--no-fund"],
      { cwd, encoding: "utf8" },
    );
  const writeDep = (seed: string, version: string) => {
    mkdirSync(join(seed, "dep"), { recursive: true });
    writeFileSync(
      join(seed, "dep/package.json"),
      JSON.stringify({ name: "dep", version }),
    );
  };
  writeDep(fx.seed, "1.0.0");
  const pkg = JSON.parse(readFileSync(join(fx.seed, "package.json"), "utf8"));
  pkg.dependencies = { dep: "file:dep" };
  writeFileSync(join(fx.seed, "package.json"), JSON.stringify(pkg));
  npmLock(fx.seed);
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "lockfile");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  mkdirSync(join(fx.local, "node_modules"), { recursive: true });
  writeFileSync(join(fx.local, "node_modules/sentinel.txt"), "old-deps");
  pushUpstream(
    fx.seed,
    (seed) => {
      const bumped = JSON.parse(
        readFileSync(join(seed, "package.json"), "utf8"),
      );
      bumped.version = "1.1.0";
      writeFileSync(join(seed, "package.json"), JSON.stringify(bumped));
      writeDep(seed, "1.1.0");
      npmLock(seed);
    },
    "bump deps",
  );
  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.depsChanged, true);
  await tx.fetchAndIntegrate();
  assert.equal(await tx.promoteCandidate(), true);
  assert.equal(existsSync(join(fx.local, "node_modules/sentinel.txt")), false);
  assert.equal(existsSync(join(fx.local, "node_modules/dep")), true);
  await tx.commit();
  await tx.teardownCandidate();
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "base",
  );
  const leftovers = readdirSync(fx.local).filter((name) =>
    name.startsWith("node_modules.iva-backup-"),
  );
  assert.deepEqual(leftovers, []);
});

test("local commits skip the candidate and keep the in-place path", async () => {
  const fx = candidateFixture();
  pushUpstream(
    fx.seed,
    (seed) => {
      writeFileSync(join(seed, "upstream.txt"), "upstream\n");
    },
    "upstream",
  );
  writeFileSync(join(fx.local, "local.txt"), "local\n");
  git(fx.local, "add", "local.txt");
  git(fx.local, "commit", "-m", "local commit");
  const tx = candidateTx(fx);
  await tx.protect();
  const update = await tx.resolveTarget();
  assert.equal(update.plan, "rebase");
  assert.equal(await tx.buildCandidate({ npm: "npm" }), null);
  const integrated = await tx.fetchAndIntegrate();
  assert.equal(integrated.changed, true);
  assert.equal(await tx.promoteCandidate(), false);
});
