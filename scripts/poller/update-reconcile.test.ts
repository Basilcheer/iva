/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import {
  chmodSync,
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
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { createVersionStore } from "../lib/version-store.ts";

const dataDir = realpathSync(
  mkdtempSync(join(tmpdir(), "iva-update-reconcile-")),
);
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

type Reconcile = (options?: {
  root?: string;
  tickMs?: number;
  graceMs?: number;
}) => Promise<Promise<void>[]>;

const { reconcileUpdateJobs } = (await import(
  `./update-flow.ts?reconcile=${Date.now()}`
)) as { reconcileUpdateJobs: Reconcile };

const OLD = "0.3.17-aaaaaaaaaaaa";
const NEW = "0.3.18-bbbbbbbbbbbb";
const jobsDir = join(dataDir, "update-jobs");
const lockDir = join(dataDir, "update.lock");

type Call = { method: string; text: string };
type MockResponse = {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
};
type MockFetch = (url: string, init: { body: string }) => Promise<MockResponse>;
type Answer = { ok: boolean; status: number; body: Record<string, unknown> };
const mutableGlobal = globalThis as unknown as { fetch: MockFetch };

const accepted: Answer = {
  ok: true,
  status: 200,
  body: { ok: true, result: { message_id: 10 } },
};
const refused = (description: string): Answer => ({
  ok: false,
  status: 400,
  body: { ok: false, description },
});

/** Telegram, as far as the reporter can tell; every call is kept in order. */
function telegram(
  t: TestContext,
  reply: (method: string, call: number) => Answer = () => accepted,
): Call[] {
  const calls: Call[] = [];
  const previous = mutableGlobal.fetch;
  t.after(() => {
    mutableGlobal.fetch = previous;
  });
  mutableGlobal.fetch = (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const body = JSON.parse(init.body) as { text?: string };
    calls.push({ method, text: body.text ?? "" });
    const answer = reply(method, calls.length);
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
    });
  };
  return calls;
}

/** An installation on the immutable layout, with `current` where the bridge finds it. */
function install(t: TestContext, current: string = NEW): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-reconcile-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The state directories are the ones this test's bridge already reads.
  writeFileSync(join(home, ".env"), `ASSISTANT_DATA_DIR=${dataDir}\n`);
  mkdirSync(join(home, "versions", current), { recursive: true });
  symlinkSync(join(home, "versions", current), join(home, "current"));
  return join(home, "current");
}

function clean(t: TestContext): void {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });
  rmSync(join(dataDir, "active.json"), { force: true });
  t.after(() => {
    rmSync(jobsDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(join(dataDir, "active.json"), { force: true });
  });
}

function job(id: string, body: Record<string, unknown>): string {
  const path = join(jobsDir, `${id}.json`);
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

const outcome = (before: string | undefined, after: string) => ({
  schema: "iva-update-outcome/v1",
  status: "updated",
  ...(before ? { before } : {}),
  after,
  custom: "none",
  finishedAt: new Date().toISOString(),
});

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const settleMarker = (version: string, settledAt?: string): void =>
  writeFileSync(
    join(dataDir, "active.json"),
    JSON.stringify({
      schema: "iva-active/v1",
      version,
      ...(settledAt ? { settledAt } : {}),
    }),
  );

const finals = (calls: readonly Call[]): string[] =>
  calls.filter((call) => call.method === "editMessageText").map((c) => c.text);

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("an outcome left by a dead updater is delivered exactly and only once", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t, (_method, call) =>
    // The retry after a crash finds the message already saying it: Telegram's
    // own answer to an identical edit is what makes a second delivery a no-op.
    call === 1 ? accepted : refused("Bad Request: message is not modified"),
  );
  const path = job("first", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(2),
    currentAtStart: OLD,
    outcome: outcome(OLD, NEW),
  });

  assert.deepEqual(await reconcileUpdateJobs({ root }), []);
  assert.equal(existsSync(path), false, "the answered job is gone");

  // The same job again: a bridge killed between the edit and the unlink.
  job("first", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(2),
    currentAtStart: OLD,
    outcome: outcome(OLD, NEW),
  });
  await reconcileUpdateJobs({ root });

  assert.equal(existsSync(path), false);
  assert.equal(finals(calls).length, 2, calls.map((c) => c.text).join(" | "));
  assert.equal(
    new Set(finals(calls)).size,
    1,
    "both attempts carry the same final screen",
  );
  assert.match(finals(calls)[0], /Iva updated/u);
  assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}`, "u"));
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
});

test("a delivery Telegram refuses keeps the job for the next start", async (t) => {
  clean(t);
  const root = install(t);
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const calls = telegram(t, () => refused("Bad Request: chat not found"));
  const path = job("refused", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(2),
    currentAtStart: OLD,
    outcome: outcome(OLD, NEW),
  });

  await reconcileUpdateJobs({ root });

  assert.equal(existsSync(path), true, "an undelivered final is not dropped");
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
  assert.ok(
    errors.some((line) => /chat not found/u.test(line)),
    errors.join("\n"),
  );
});

test(
  "a job file that cannot be removed costs the chat nothing else",
  {
    // Permissions do not apply to root, so neither does the failure being proved.
    skip: process.getuid?.() === 0 && "root writes through any directory",
  },
  async (t) => {
    clean(t);
    const root = install(t);
    const lines: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) =>
      lines.push(args.map(String).join(" ")),
    );
    const calls = telegram(t);
    const body = {
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(2),
      currentAtStart: OLD,
      outcome: outcome(OLD, NEW),
    };
    const first = job("stuck-a", body);
    const second = job("stuck-b", { ...body, messageId: 101 });
    // A read-only jobs directory: every final goes out, no job file can be unlinked.
    // This runs before the first poll, so a throw here is a bridge that never polls.
    chmodSync(jobsDir, 0o555);
    try {
      assert.deepEqual(await reconcileUpdateJobs({ root }), [], "no watchers");
    } finally {
      chmodSync(jobsDir, 0o755);
    }

    assert.equal(finals(calls).length, 2, finals(calls).join(" | "));
    assert.equal(
      existsSync(first),
      true,
      "an undeletable job waits for the TTL",
    );
    assert.equal(existsSync(second), true, "and so does the one behind it");
    assert.ok(
      lines.filter((line) => /update job reconcile failed/u.test(line))
        .length === 2,
      lines.join("\n"),
    );
  },
);

test("a job killed after the flip is answered from what the installation says", async (t) => {
  for (const settledAt of [minutesAgo(1), undefined]) {
    await t.test(`settle marker time: ${settledAt ?? "absent"}`, async (st) => {
      clean(st);
      const root = install(st);
      settleMarker(NEW, settledAt);
      const calls = telegram(st);
      const path = job("killed", {
        chatId: 1,
        messageId: 100,
        locale: "en",
        startedAt: minutesAgo(3),
        currentAtStart: OLD,
      });

      const watchers = await reconcileUpdateJobs({
        root,
        tickMs: 5,
        graceMs: 15,
      });
      assert.equal(watchers.length, 1, "a job with no outcome is watched");
      await Promise.all(watchers);

      assert.equal(existsSync(path), false);
      assert.deepEqual(finals(calls).length, 1, finals(calls).join(" | "));
      assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}`, "u"));
    });
  }
});

test("an outcome that arrives while the job is watched wins over the guess", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t);
  const path = job("late", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
  });
  // The lock is held by a live process, exactly as an updater in the middle of a
  // build holds it: nothing may be said about the update while it runs.
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );

  const watchers = await reconcileUpdateJobs({ root, tickMs: 5, graceMs: 10 });
  await wait(60);
  assert.deepEqual(calls, [], "a running update is never reported on");

  writeFileSync(
    path,
    JSON.stringify({
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(1),
      currentAtStart: OLD,
      outcome: outcome(OLD, `${NEW}~2`),
    }),
  );
  rmSync(lockDir, { recursive: true, force: true });
  await Promise.all(watchers);

  assert.equal(existsSync(path), false);
  assert.equal(finals(calls).length, 1);
  assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}~2`, "u"));
});

test("a job from a bridge that never named a version falls back to the settle marker", async (t) => {
  clean(t);
  const root = install(t);
  settleMarker(NEW, minutesAgo(1));
  const calls = telegram(t);
  const path = job("transitional", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  await Promise.all(
    await reconcileUpdateJobs({ root, tickMs: 5, graceMs: 15 }),
  );

  assert.equal(existsSync(path), false);
  assert.equal(finals(calls).length, 1);
  assert.match(finals(calls)[0], /Iva updated/u);
  assert.match(finals(calls)[0], new RegExp(`Version: ${NEW}`, "u"));
  assert.doesNotMatch(finals(calls)[0], /→/u);
});

test("nothing is said when no evidence says the update finished", async (t) => {
  clean(t);
  const root = install(t);
  // The last move predates the tap: this settle marker is somebody else's.
  settleMarker(NEW, minutesAgo(90));
  const calls = telegram(t);
  const path = job("unproven", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  await Promise.all(
    await reconcileUpdateJobs({ root, tickMs: 5, graceMs: 15 }),
  );

  assert.deepEqual(calls, [], "a false ✅ is worse than a spinner");
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("a rollback is never a ✅ on a job that never named its version", async (t) => {
  clean(t);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-reconcile-home-")));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(join(dataDir, "live-failures.json"), { force: true });
  });
  writeFileSync(join(home, ".env"), `ASSISTANT_DATA_DIR=${dataDir}\n`);
  for (const name of [OLD, NEW])
    mkdirSync(join(home, "versions", name), { recursive: true });
  // The build the update installed is the newest on disk; the one it went back to
  // is older. Set, not assumed: the order is what tells a rollback from a success.
  const hourAgo = Date.now() / 1000 - 3600;
  utimesSync(join(home, "versions", OLD), hourAgo, hourAgo);
  symlinkSync(join(home, "versions", OLD), join(home, "current"));
  // Exactly what the updater writes on an unhealthy flip: the dead build recorded,
  // then the flip back, then a settle marker as fresh as a good update's.
  const store = createVersionStore(home);
  store.recordLive(NEW, false);
  store.settle(OLD);
  const calls = telegram(t);
  const path = job("rolled-back", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  await Promise.all(
    await reconcileUpdateJobs({
      root: join(home, "current"),
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(
    calls,
    [],
    "the version that failed is not one to celebrate",
  );
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("a job the updater answered itself is dropped without a second word", async (t) => {
  clean(t);
  // Nothing was installed, so nothing flipped: the updater reported the failure
  // through its own reporter and took the job file with it.
  const root = install(t, OLD);
  const calls = telegram(t);
  const path = job("failed", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
  });

  const watchers = await reconcileUpdateJobs({ root, tickMs: 5, graceMs: 15 });
  rmSync(path, { force: true });
  await Promise.all(watchers);

  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(jobsDir), []);
});

/** Deterministic noise: the seed is printed, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("an outcome written under a reader is never read half-written", async (t) => {
  clean(t);
  const seed = Number(process.env.IVA_TEST_SEED ?? Date.now() % 2 ** 31);
  console.log(`randomized outcome interleaving seed: ${seed}`);
  t.diagnostic(`seed ${seed}`);
  const random = mulberry32(seed);
  const before = {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
    // Long enough that a plain write would need more than one page.
    padding: "x".repeat(64 * 1024),
  };
  const path = job("racy", before);
  const after = { ...before, outcome: outcome(OLD, NEW) };

  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(parsed && typeof parsed === "object");
      const seen = parsed as { padding?: string; outcome?: unknown };
      assert.equal(seen.padding, before.padding, "a whole job, never a piece");
      assert.ok(seen.outcome === undefined || typeof seen.outcome === "object");
      reads += 1;
      if (random() < 0.3) await wait(0);
    }
  })();

  for (let round = 0; round < 30; round++) {
    await wait(Math.floor(random() * 3));
    await writeFileAtomic(
      path,
      JSON.stringify(round % 2 === 0 ? after : before),
      { mode: 0o600 },
    );
  }
  stop = true;
  await reader;

  assert.ok(reads > 30, `the reader ran ${reads} times`);
});
