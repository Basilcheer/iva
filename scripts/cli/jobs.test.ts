/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva jobs ack <name>` (T20 п.3): закрывает последний провал имени, пустой ack честно
// говорит, что закрывать нечего, без имени — usage.
import assert from "node:assert/strict";
import test from "node:test";

import { createJobsCommand } from "./jobs.ts";

function harness(closed: number) {
  const calls: { file: string; name: string }[] = [];
  const ok: string[] = [];
  const bad: string[] = [];
  const runtime = {
    ENV_PATH: "/tmp/t20-cli-jobs/.env",
    ok: (message: string) => ok.push(message),
    bad: (message: string) => bad.push(message),
    dataDirAbs: () => "/tmp/t20-cli-jobs/data",
  };
  const cmd = createJobsCommand(runtime as never, {
    ack: (file, name) => {
      calls.push({ file, name });
      return Promise.resolve(closed);
    },
    readEnv: () => Promise.resolve({}),
  });
  return { cmd, calls, ok, bad };
}

test("ack закрывает провал имени в таблице фактов", async () => {
  const { cmd, calls, ok, bad } = harness(1);
  await cmd(["ack", "memory-daily"]);
  assert.deepEqual(calls, [
    { file: "/tmp/t20-cli-jobs/data/jobs.json", name: "memory-daily" },
  ]);
  assert.deepEqual(bad, []);
  assert.match(ok[0] ?? "", /memory-daily/u);
});

test("ack без открытого провала говорит об этом", async () => {
  const { cmd, ok, bad } = harness(0);
  await cmd(["ack", "digest"]);
  assert.deepEqual(ok, []);
  assert.match(bad[0] ?? "", /no open failure/u);
});

test("без подкоманды и имени — usage", async () => {
  const { cmd } = harness(0);
  await assert.rejects(cmd([]), /usage: iva jobs ack/u);
  await assert.rejects(cmd(["ack"]), /usage: iva jobs ack/u);
  await assert.rejects(cmd(["list"]), /usage: iva jobs ack/u);
});

// `iva jobs skip memory-daily <date>`: под замком ночи (путь из резолвера schedule-paths)
// отметка конца дня кодом, коммит vault, стирание попыток дня; отказ коммита — ошибка,
// попытки на месте.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayProgress } from "../lib/rollup-days.ts";

function skipHarness(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "iva-cli-jobs-skip-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const vault = join(root, "vault");
  const data = join(root, "data");
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const state = {
    commitOk: true,
    lock: null as number | null,
    locks: [] as string[],
    commits: [] as string[],
    ok: [] as string[],
  };
  const runtime = {
    ENV_PATH: join(root, ".env"),
    ROOT: root,
    ok: (message: string) => state.ok.push(message),
    bad: () => {},
    dataDirAbs: () => data,
  };
  const cmd = createJobsCommand(runtime as never, {
    commit: (message, paths, commitRoot) => {
      state.commits.push(`${message} ${paths.join(",")} ${commitRoot}`);
      return Promise.resolve(
        state.commitOk
          ? { ok: true, committed: true }
          : { ok: false, reason: "index.lock exists" },
      );
    },
    lock: (lockPath) => {
      state.locks.push(lockPath);
      return state.lock;
    },
    readEnv: () =>
      Promise.resolve({
        ASSISTANT_TIMEZONE: "UTC",
        ASSISTANT_VAULT_DIR: vault,
      }),
    now: () => new Date("2026-09-26T09:00:00.000Z"),
  });
  const raw = join(vault, "daily", "2026-09-24.md");
  writeFileSync(raw, "## 10:00 [text]\n\nтяжёлый день\n");
  const attempts = join(data, "rollup-attempts.json");
  const at = "2026-09-26T08:00:00.000Z";
  writeFileSync(
    attempts,
    JSON.stringify({
      "2026-09-24": [{ at, reason: "cut" }],
      "2026-09-23": [{ at, reason: "no-report" }],
    }),
  );
  const skip = (date = "2026-09-24") => cmd(["skip", "memory-daily", date]);
  return { cmd, skip, root, vault, raw, attempts, state };
}

test("skip closes a past day with the end marker the night reads, commits it and clears its attempts", async (t) => {
  const { skip, root, vault, raw, attempts, state } = skipHarness(t);

  await skip();

  const text = readFileSync(raw, "utf8");
  assert.match(
    text,
    /<!-- processed: skipped by owner 2026-09-26T09:00:00\.000Z -->\n$/u,
  );
  assert.equal(dayProgress(text).done, true);
  assert.deepEqual(state.locks, [join(root, ".memory.lock")]);
  assert.deepEqual(state.commits, [
    `file daily/2026-09-24.md: skipped by owner ${raw} ${vault}`,
  ]);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(attempts, "utf8")) as object),
    ["2026-09-23"],
  );
  assert.match(state.ok[0] ?? "", /closed 2026-09-24/u);
});

test("skip refuses today, a future day, a bad date and a day without its raw file", async (t) => {
  const { cmd, skip, state } = skipHarness(t);
  for (const date of ["2026-09-26", "2026-10-01", "2026-02-30"])
    await assert.rejects(skip(date), /is not a finished day/u);
  await assert.rejects(skip("2026-09-20"), /nothing to close/u);
  await assert.rejects(
    cmd(["skip", "digest", "2026-09-20"]),
    /usage: iva jobs/u,
  );
  assert.deepEqual(state.commits, []);
});

test("a failed vault commit fails the command and keeps the attempts; a rerun finishes the commit", async (t) => {
  const { skip, raw, attempts, state } = skipHarness(t);
  const before = readFileSync(attempts, "utf8");
  state.commitOk = false;

  await assert.rejects(
    skip(),
    /vault commit failed \(index\.lock exists\) — run the command again/u,
  );
  assert.equal(readFileSync(attempts, "utf8"), before);
  assert.deepEqual(state.ok, []);

  const marked = readFileSync(raw, "utf8");
  state.commitOk = true;
  await skip();
  assert.equal(readFileSync(raw, "utf8"), marked, "no second marker");
  assert.equal(state.commits.length, 2);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(attempts, "utf8")) as object),
    ["2026-09-23"],
  );
});

test("skip runs under the night's .memory.lock: a held lock changes nothing", async (t) => {
  const { skip, raw, attempts, state } = skipHarness(t);
  const before = [readFileSync(raw, "utf8"), readFileSync(attempts, "utf8")];
  const exitCode = process.exitCode;
  t.after(() => {
    process.exitCode = exitCode;
  });
  state.lock = 1;

  await skip();

  assert.equal(process.exitCode, 1);
  assert.deepEqual(
    [readFileSync(raw, "utf8"), readFileSync(attempts, "utf8")],
    before,
  );
  assert.deepEqual(state.commits, []);
});
