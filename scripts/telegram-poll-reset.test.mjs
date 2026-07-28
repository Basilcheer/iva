import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "iva-scoped-reset-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";

const [{
  clearPrivateResetIntent,
  completeScopedResetState,
  drainReadyQueueHeads,
  loadPrivateResetIntents,
  loadQueue,
  performScopedReset,
  persistPrivateResetIntent,
  reconcileScopedResetIntents,
  writeQueueAtomic,
}, status] = await Promise.all([
  import(`./telegram-poll.mjs?reset-test=${Date.now()}`),
  import(`./lib/run-status.mjs?reset-test=${Date.now()}`),
]);

test("private reset clears only the target chat status and queue", async () => {
  status.setChatStatus("chat-a:", {
    status: "running",
    continuationToken: "chat-a::",
    sessionId: "session-a",
    turnId: "turn-a",
  });
  status.setChatStatus("chat-b:7", {
    status: "running",
    continuationToken: "chat-b:7:reply",
    sessionId: "session-b",
    turnId: "turn-b",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "chat-a:": ["discard me"],
      "chat-b:7": ["keep me"],
    }),
  );

  await completeScopedResetState("chat-a:", "chat-a::", { clearQueue: true });

  const reset = status.getChatStatus("chat-a:");
  assert.equal(reset.status, "idle");
  assert.equal(reset.continuationToken, "chat-a::");
  assert.equal(reset.sessionId, undefined);
  assert.equal(reset.turnId, undefined);

  const untouched = status.getChatStatus("chat-b:7");
  assert.equal(untouched.status, "running");
  assert.equal(untouched.sessionId, "session-b");
  assert.equal(untouched.continuationToken, "chat-b:7:reply");

  const queue = JSON.parse(readFileSync(join(dataDir, "telegram-queue.json"), "utf8"));
  assert.equal(queue.version, 1);
  assert.deepEqual(Object.keys(queue.queues), ["chat-b:7"]);
  assert.equal(queue.queues["chat-b:7"][0].legacyText, "keep me");
});

test("group reset preserves the shared topic queue", async () => {
  status.setChatStatus("group:7", {
    status: "running",
    continuationToken: "group:7:reply-a",
    sessionId: "session-a",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    }),
  );

  await completeScopedResetState("group:7", "group:7:reply-a", {
    clearQueue: false,
  });

  assert.equal(status.getChatStatus("group:7").status, "idle");
  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir, "telegram-queue.json"), "utf8")),
    {
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    },
  );
});

test("failed private queue cleanup does not expose an idle tombstone", async () => {
  status.setChatStatus("chat-c:", {
    status: "running",
    continuationToken: "chat-c::",
    sessionId: "session-c",
  });

  await assert.rejects(
    completeScopedResetState("chat-c:", "chat-c::", {
      clearQueue: true,
      clearQueueImpl: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(status.getChatStatus("chat-c:").status, "running");
  assert.equal(status.getChatStatus("chat-c:").sessionId, "session-c");
});

test("private reset intent is durable before remote reset and clears after local cleanup", async () => {
  const events = [];
  await performScopedReset("chat-intent:", "chat-intent::", {
    clearQueue: true,
    persistIntentImpl: async () => events.push("intent"),
    requestResetImpl: async () => events.push("remote"),
    completeStateImpl: async () => events.push("cleanup"),
    clearIntentImpl: async () => events.push("clear-intent"),
  });

  assert.deepEqual(events, ["intent", "remote", "cleanup", "clear-intent"]);
});

test("startup reconciliation prevents a remotely reset private queue from draining after a crash", async () => {
  const key = "chat-crash:";
  const continuationToken = "chat-crash::";
  status.setChatStatus(key, {
    status: "running",
    continuationToken,
    sessionId: "old-session",
    turnId: "old-turn",
  });
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [{
        version: 1,
        updateId: 901,
        enqueuedAt: 1,
        update: {
          update_id: 901,
          message: {
            message_id: 901,
            date: 1,
            chat: { id: 901, type: "private" },
            from: { id: 42, is_bot: false, first_name: "Owner" },
            text: "must be discarded after reset",
          },
        },
      }],
    },
  });
  await persistPrivateResetIntent(key, continuationToken);

  const remoteRetries = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (intent) => {
      remoteRetries.push(intent);
    },
  });

  assert.deepEqual(
    remoteRetries.map(({ chatKey, continuationToken: token }) => [chatKey, token]),
    [[key, continuationToken]],
  );
  assert.deepEqual(await loadPrivateResetIntents(), []);
  assert.equal(status.getChatStatus(key).status, "idle");
  assert.equal(status.getChatStatus(key).sessionId, undefined);
  assert.equal((await loadQueue()).queues[key], undefined);

  const delivered = [];
  assert.equal(
    await drainReadyQueueHeads({
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
    }),
    0,
  );
  assert.deepEqual(delivered, [], "startup must reconcile reset intent before any old head can drain");
});

test("failed reset reconciliation keeps its durable intent for the next startup", async () => {
  const key = "chat-retry:";
  await persistPrivateResetIntent(key, "chat-retry::");

  await assert.rejects(
    reconcileScopedResetIntents({
      requestResetImpl: async () => {
        throw new Error("eve unavailable");
      },
    }),
    /eve unavailable/,
  );

  assert.deepEqual(
    (await loadPrivateResetIntents()).map(({ chatKey }) => chatKey),
    [key],
  );
  await clearPrivateResetIntent(key);
});

test("queue rename failure keeps the previous whole queue byte-for-byte", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const original = JSON.stringify({
    "chat-d:": ["keep this"],
    "chat-e:": ["keep this too"],
  });
  writeFileSync(queueFile, original);

  await assert.rejects(
    writeQueueAtomic(
      { "chat-d:": ["replacement"] },
      {
        nonce: "fault-injection",
        renameImpl: async () => {
          throw new Error("injected rename failure");
        },
      },
    ),
    /injected rename failure/,
  );

  assert.equal(readFileSync(queueFile, "utf8"), original);
  assert.equal(
    readdirSync(dataDir).some((name) => name.startsWith("telegram-queue.json.tmp-")),
    false,
  );
});

test("corrupt queue is not treated as empty during reset", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const corrupt = '{"chat-f:": ["unfinished"';
  writeFileSync(queueFile, corrupt);
  status.setChatStatus("chat-f:", {
    status: "running",
    continuationToken: "chat-f::",
    sessionId: "session-f",
  });

  await assert.rejects(
    completeScopedResetState("chat-f:", "chat-f::", { clearQueue: true }),
    SyntaxError,
  );

  assert.equal(readFileSync(queueFile, "utf8"), corrupt);
  assert.equal(status.getChatStatus("chat-f:").status, "running");
});

test("ordinary queue load quarantines corrupt bytes and continues", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const corrupt = '{"chat-g:": ["unfinished"';
  writeFileSync(queueFile, corrupt);

  assert.deepEqual(await loadQueue(), { version: 1, queues: {} });

  const backups = readdirSync(dataDir).filter((name) =>
    name.startsWith("telegram-queue.json.corrupt-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dataDir, backups[0]), "utf8"), corrupt);
});
