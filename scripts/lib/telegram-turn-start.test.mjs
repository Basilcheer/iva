import test from "node:test";
import assert from "node:assert/strict";

import { publishTelegramTurnStarted } from "./telegram-turn-start.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("turn.started publishes running before the working-status request can block", async () => {
  const working = deferred();
  const events = [];
  let status = { status: "idle" };

  const publishing = publishTelegramTurnStarted({
    chatKey: "1:",
    continuationToken: "1::",
    sessionId: "session-1",
    turnId: "turn-1",
    setStatusImpl: (_key, patch) => {
      events.push("running");
      status = { ...status, ...patch };
      return status;
    },
    setStatusIfImpl: (_key, expected, patch) => {
      assert.equal(status.status, expected.status);
      assert.equal(status.sessionId, expected.sessionId);
      assert.equal(status.turnId, expected.turnId);
      events.push("status-message");
      status = { ...status, ...patch };
      return status;
    },
    sendWorkingStatusImpl: async () => {
      events.push("working-request");
      return working.promise;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.status, "running");
  assert.equal(status.statusMessageId, null);
  assert.deepEqual(events, ["running", "working-request"]);

  working.resolve(77);
  await publishing;
  assert.equal(status.statusMessageId, 77);
  assert.deepEqual(events, ["running", "working-request", "status-message"]);
});

test("a late working-status response cannot attach to a completed or newer turn", async () => {
  const working = deferred();
  let status = { status: "idle" };
  const removed = [];

  const publishing = publishTelegramTurnStarted({
    chatKey: "1:",
    continuationToken: "1::",
    sessionId: "session-1",
    turnId: "turn-1",
    setStatusImpl: (_key, patch) => {
      status = { ...status, ...patch };
      return status;
    },
    setStatusIfImpl: (_key, expected, patch) => {
      if (
        status.status !== expected.status ||
        status.sessionId !== expected.sessionId ||
        status.turnId !== expected.turnId
      ) {
        return null;
      }
      status = { ...status, ...patch };
      return status;
    },
    sendWorkingStatusImpl: () => working.promise,
    removeWorkingStatusImpl: async (messageId) => {
      removed.push(messageId);
    },
  });

  status = { status: "idle", sessionId: "session-2", turnId: "turn-2" };
  working.resolve(78);
  await publishing;

  assert.deepEqual(removed, [78]);
  assert.equal(status.statusMessageId, undefined);
});
