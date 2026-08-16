/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-update-flow-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

const { handleUpdateCallback, handleUpdateCheck, removeStaleUpdateJobs } =
  (await import(`./update-flow.ts?characterize=${Date.now()}`)) as {
    handleUpdateCallback: (query: {
      id: string;
      from: { id: number };
      message: { chat: { id: number }; message_id: number };
      data: string;
    }) => Promise<boolean>;
    handleUpdateCheck: (
      chatId: number,
      options: {
        root?: string;
        markNotifiedImpl?: (dataDir: string, version: string) => Promise<void>;
        envImpl?: () => Promise<NodeJS.ProcessEnv>;
      },
    ) => Promise<void>;
    removeStaleUpdateJobs: () => Promise<void>;
  };

test("stale update-job cleanup removes only expired JSON job files", async () => {
  const jobs = join(dataDir, "update-jobs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(jobs));
  const oldJob = join(jobs, "old.json");
  const freshJob = join(jobs, "fresh.json");
  const other = join(jobs, "keep.txt");
  writeFileSync(oldJob, "{}");
  writeFileSync(freshJob, "{}");
  writeFileSync(other, "keep");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(oldJob, old, old);

  await removeStaleUpdateJobs();

  await assert.doesNotReject(() =>
    import("node:fs/promises").then(({ stat }) => stat(freshJob)),
  );
  await assert.doesNotReject(() =>
    import("node:fs/promises").then(({ stat }) => stat(other)),
  );
  await assert.rejects(() =>
    import("node:fs/promises").then(({ stat }) => stat(oldJob)),
  );
});

type MockFetch = (
  url: string,
  init: { body?: string },
) => Promise<{ json(): Promise<{ ok: boolean; result: unknown }> }>;
const mutableGlobal: { fetch: MockFetch } = globalThis;

/**
 * Tap the /update button and collect the texts Telegram was sent. `systemd-run`
 * is a stand-in that records the command line: the launch is real, the update
 * behind it is not.
 */
async function press(launcher: string): Promise<string[]> {
  const texts: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  const previousPath = process.env.PATH;
  mutableGlobal.fetch = (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as { text?: string };
    if (typeof body.text === "string") texts.push(body.text);
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
  };
  process.env.PATH = launcher;
  try {
    await handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: "iva_update:do",
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
    process.env.PATH = previousPath;
  }
  return texts;
}

test("invalid update callback data only clears the Telegram spinner", async () => {
  const methods: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (url) => {
    methods.push(url.split("/").at(-1) ?? "");
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
  };
  try {
    await handleUpdateCallback({
      id: "invalid-callback",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: "iva_update:garbage",
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
  }
  assert.deepEqual(methods, ["answerCallbackQuery"]);
});

test("skip callback is retained when edit returns a false result", async () => {
  const methods: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (url) => {
    const method = url.split("/").at(-1) ?? "";
    methods.push(method);
    return Promise.resolve({
      json: () =>
        Promise.resolve(
          method === "answerCallbackQuery"
            ? { ok: false, result: true }
            : { ok: true, result: false },
        ),
    });
  };
  try {
    const handled = await handleUpdateCallback({
      id: "failed-skip",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: "iva_update:skip",
    });
    assert.equal(handled, false);
  } finally {
    mutableGlobal.fetch = previousFetch;
  }
  assert.deepEqual(methods, ["answerCallbackQuery", "editMessageText"]);
});

test("the /update button leaves the lock to the update it launches", async (t) => {
  const lock = join(dataDir, "update.lock");
  const jobs = join(dataDir, "update-jobs");
  rmSync(jobs, { recursive: true, force: true }); // The cleanup test's leftovers.
  const launched = join(dataDir, "launched.log");
  const bin = join(dataDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "systemd-run"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${launched}"\nexit 0\n`,
    { mode: 0o755 },
  );
  t.after(() => {
    for (const path of [lock, jobs, bin, launched])
      rmSync(path, { recursive: true, force: true });
  });

  const first = await press(bin);

  assert.match(first.at(-1) ?? "", /Saving your changes/u);
  assert.match(
    readFileSync(launched, "utf8"),
    /update --telegram-job [0-9a-f]/u,
  );
  assert.equal(
    readdirSync(jobs).length,
    1,
    "the update has its job to report to",
  );
  // Nothing claimed on the updater's behalf: a lock taken here would never be
  // released - this process outlives the update and is restarted by it - and the
  // updater, seeing an owner that is alive, would refuse to run at all.
  assert.equal(existsSync(lock), false, first.join(" | "));

  // So a second tap is answered by starting an update, not by a wedged lock.
  assert.match((await press(bin)).at(-1) ?? "", /Saving your changes/u);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(jobs).length, 2);

  // A launcher that fails takes the job file back down with it.
  rmSync(join(bin, "systemd-run"));
  assert.match((await press(bin)).at(-1) ?? "", /Couldn't start the update/u);
  assert.equal(readdirSync(jobs).length, 2);

  // And an update that is really running is answered before anything is launched.
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  assert.deepEqual(await press(bin), ["⚠️ An update is already running"]);
  assert.equal(readdirSync(jobs).length, 2);
});

test("saved update view explains a preserved change set with no conflicts", async (t) => {
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const bundle = "2026-08-07T00-00-00-000Z-deadbeef1234";
  const bundleDir = join(dataDir, "update-conflicts", bundle);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "report.json"),
    JSON.stringify({ schema: "iva-update-conflicts/v1", conflicts: [] }),
  );
  const calls: { method: string | undefined; body: unknown }[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (url, init) => {
    const body: unknown = JSON.parse(init.body ?? "{}");
    calls.push({
      method: url.split("/").at(-1),
      body,
    });
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
  };
  try {
    await handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: `iva_update:conflicts:${bundle}`,
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
  }

  const edit = calls.find((call) => call.method === "editMessageText");
  const text =
    edit?.body &&
    typeof edit.body === "object" &&
    "text" in edit.body &&
    typeof edit.body.text === "string"
      ? edit.body.text
      : "";
  assert.match(text, /saved in full/i);
  assert.doesNotMatch(text, /Saved local conflicts:/);
});

/** git in a directory, with an identity, so a commit needs no ambient config. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
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
}

/**
 * An installation as the bridge leaves it: no working tree, history only in the
 * bare mirror, and the running code reached through `current`. Exactly the layout
 * every converted user has, and the one a checkout-era update check dies on.
 */
function converted(t: TestContext, { mirror = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-converted-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const home = join(dir, "iva");
  mkdirSync(source, { recursive: true });
  const release = (version: string): void =>
    writeFileSync(
      join(source, "package.json"),
      `${JSON.stringify({ name: "iva", version })}\n`,
    );
  release("0.3.15");
  git(source, ["init", "--initial-branch=main"]);
  git(source, ["add", "-A"]);
  git(source, ["commit", "-m", "initial"]);
  const sha = git(source, ["rev-parse", "HEAD"]);

  const name = `0.3.15-${sha.slice(0, 12)}`;
  mkdirSync(join(home, "versions", name), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  symlinkSync(join(home, "versions", name), join(home, "current"));
  if (mirror) git(dir, ["clone", "-q", "--mirror", source, join(home, "repo")]);
  return {
    /** What the poller's own ROOT is on a converted box. */
    root: join(home, "current"),
    home,
    source,
    publish: (version: string): void => {
      release(version);
      git(source, ["add", "-A"]);
      git(source, ["commit", "-m", `release ${version}`]);
    },
  };
}

/** Drives /update with the real upstream check and returns what Telegram was told. */
async function check(root: string): Promise<string[]> {
  const texts: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as { text?: string };
    if (typeof body.text === "string") texts.push(body.text);
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: { message_id: 10 } }),
    });
  };
  try {
    await handleUpdateCheck(1, {
      root,
      markNotifiedImpl: () => Promise.resolve(),
      envImpl: () => Promise.resolve({ MODEL_PROVIDER: "codex" }),
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
  }
  return texts;
}

test("/update offers the new release on an installation with no working tree", async (t) => {
  const install = converted(t);
  install.publish("0.3.16");

  const texts = await check(install.root);

  assert.equal(texts.length, 2, texts.join(" | "));
  assert.match(texts[1] ?? "", /Update available/u);
  assert.match(texts[1] ?? "", /v0\.3\.15 → v0\.3\.16/u);
});

test("/update reports the version that runs, not the mirror's moving HEAD", async (t) => {
  const install = converted(t);

  const texts = await check(install.root);

  // The mirror's own HEAD is upstream's; asking it about "HEAD" would compare the
  // installation with itself and answer "up to date" through every release.
  assert.match(texts[1] ?? "", /You're up to date/u);
  assert.match(texts[1] ?? "", /Iva v0\.3\.15/u);
});

test("/update fails loudly rather than answering about the repository above the install", async (t) => {
  const install = converted(t, { mirror: false });
  // A box whose $HOME is a git repository of its own - versioned dotfiles - is
  // where git's climb to a parent turns a missing mirror into a wrong answer.
  const above = join(install.home, "..");
  git(above, ["init", "--initial-branch=main"]);
  writeFileSync(join(above, "dotfile"), "\n");
  git(above, ["add", "-A"]);
  git(above, ["commit", "-m", "dotfiles"]);
  // With a remote of its own that repository answers every question the check
  // asks: a climb ends in a confident report about somebody else's history.
  git(above, ["remote", "add", "origin", install.source]);

  const texts = await check(install.root);

  assert.match(texts[1] ?? "", /Couldn't check for updates/u);
});
