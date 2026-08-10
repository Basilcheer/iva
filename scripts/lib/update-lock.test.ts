/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock } from "./version-store.ts";

function dataDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "data");
}

test("one holder at a time, and releasing hands it straight over", (t) => {
  const data = dataDir(t);

  const first = acquireUpdateLock(data);
  assert.ok(first);
  assert.equal(acquireUpdateLock(data), null);
  assert.equal(acquireUpdateLock(data), null);

  first.release();
  const second = acquireUpdateLock(data);
  assert.ok(second);
  second.release();
  assert.equal(existsSync(join(data, "update.lock")), false);
  // Releasing twice is harmless; a failed update may unwind more than once.
  second.release();
});

test("a lock left behind by a killed update is taken over immediately", async (t) => {
  const data = dataDir(t);
  // A real process that dies while holding the lock, exactly as kill -9 leaves it.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  mkdirSync(join(data, "update.lock"), { recursive: true });
  writeFileSync(
    join(data, "update.lock/owner.json"),
    JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
  );
  assert.equal(acquireUpdateLock(data), null, "a live owner still holds it");

  const exited = new Promise((resolve) => child.on("close", resolve));
  child.kill("SIGKILL");
  await exited;

  const taken = acquireUpdateLock(data);
  assert.ok(taken, "a dead owner must not block the retry that cleans up");
  taken.release();
});

test("a lock with no readable owner is respected until it is plainly old", (t) => {
  const data = dataDir(t);
  const lock = join(data, "update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), "{ truncated");

  assert.equal(acquireUpdateLock(data), null);

  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(lock, old, old);
  const taken = acquireUpdateLock(data);
  assert.ok(taken);
  taken.release();
});
