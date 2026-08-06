import assert from "node:assert/strict";
import test from "node:test";
import { userbotSyncArgs } from "./userbot-deps.ts";

void test("userbot install enforces hashes and exact environment sync", () => {
  assert.deepEqual(
    userbotSyncArgs({
      pythonPath: "/tmp/venv/bin/python",
      requirementsFile: "requirements.lock",
      requirementsText: "idna==3.18 --hash=sha256:abc",
    }),
    [
      "pip",
      "sync",
      "--python",
      "/tmp/venv/bin/python",
      "--require-hashes",
      "--strict",
      "requirements.lock",
    ],
  );
});

void test("unhashed requirements are rejected during normal setup and update", () => {
  assert.throws(
    () =>
      userbotSyncArgs({
        pythonPath: "/tmp/venv/bin/python",
        requirementsFile: "requirements.lock",
        requirementsText: "idna>=3",
      }),
    /requirements\.lock не содержит hashes/,
  );
});

void test("rollback syncs the exact frozen environment and removes extras", () => {
  assert.deepEqual(
    userbotSyncArgs({
      pythonPath: "/tmp/venv/bin/python",
      requirementsFile: "/tmp/userbot-before-update.txt",
      requirementsText: "idna==3.17",
      requireHashes: false,
    }),
    [
      "pip",
      "sync",
      "--python",
      "/tmp/venv/bin/python",
      "/tmp/userbot-before-update.txt",
    ],
  );
});
