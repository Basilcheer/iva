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
    continuationToken: "101::",
    sessionId: "session-a",
    turnId: "turn-a",
  });
  status.setChatStatus("chat-b:7", {
    status: "running",
    continuationToken: "-102:7:55",
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

  await completeScopedResetState("chat-a:", "101::", { clearQueue: true });

  const reset = status.getChatStatus("chat-a:");
  assert.equal(reset.status, "idle");
  assert.equal(reset.continuationToken, "101::");
  assert.equal(reset.sessionId, undefined);
  assert.equal(reset.turnId, undefined);

  const untouched = status.getChatStatus("chat-b:7");
  assert.equal(untouched.status, "running");
  assert.equal(untouched.sessionId, "session-b");
  assert.equal(untouched.continuationToken, "-102:7:55");

  const queue = JSON.parse(readFileSync(join(dataDir, "telegram-queue.json"), "utf8"));
  assert.equal(queue.version, 1);
  assert.deepEqual(Object.keys(queue.queues), ["chat-b:7"]);
  assert.equal(queue.queues["chat-b:7"][0].legacyText, "keep me");
});

test("group reset preserves the shared topic queue", async () => {
  status.setChatStatus("group:7", {
    status: "running",
    continuationToken: "-103:7:56",
    sessionId: "session-a",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    }),
  );

  await completeScopedResetState("group:7", "-103:7:56", {
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
    continuationToken: "104::",
    sessionId: "session-c",
  });

  await assert.rejects(
    completeScopedResetState("chat-c:", "104::", {
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
  await performScopedReset("chat-intent:", "105::", {
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
  const continuationToken = "106::";
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
  await persistPrivateResetIntent(key, "107::");

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
    continuationToken: "108::",
    sessionId: "session-f",
  });

  await assert.rejects(
    completeScopedResetState("chat-f:", "108::", { clearQueue: true }),
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

test("reset tombstone stores the token channel-local (#110)", async () => {
  // Токен приходит из статуса, а тот до фикса заполнялся namespaced-значением eve.
  // Надгробие переживает рестарт и потом само уходит в reset — сохранить его как есть
  // значило бы законсервировать «telegram:telegram:…» и молчаливый no_active_session.
  await completeScopedResetState("7091451031:", "telegram:7091451031::", { clearQueue: true });

  const tombstone = status.getChatStatus("7091451031:");
  assert.equal(tombstone.status, "idle");
  assert.equal(tombstone.continuationToken, "7091451031::");
});

test("a reset intent written before the fix is retried channel-local (#110)", async () => {
  const key = "429888768:";
  await persistPrivateResetIntent(key, "telegram:429888768::");

  const requested = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async ({ continuationToken }) => {
      // Точка выхода наружу — то, что реально уедет в /eve/v1/telegram/reset.
      requested.push(continuationToken);
    },
  });

  assert.deepEqual(requested, ["429888768::"]);
  assert.equal(status.getChatStatus(key).continuationToken, "429888768::");
});

test("/new sends the reset channel-local even from a namespaced status (#110)", async () => {
  const requested = [];
  await performScopedReset("7091451031:", "telegram:7091451031::", {
    clearQueue: true,
    persistIntentImpl: async () => {},
    requestResetImpl: async ({ continuationToken }) => requested.push(continuationToken),
    completeStateImpl: async () => {},
    clearIntentImpl: async () => {},
  });

  assert.deepEqual(requested, ["7091451031::"]);
});

test("reset outcome is logged, including the silent no_active_session (#110)", async () => {
  // Именно no_active_session маскировал баг: сброс «удавался», не сбросив ничего.
  // Теперь исход и точный токен видны в journalctl моста.
  const lines = [];
  await performScopedReset("7091451031:", "telegram:7091451031::", {
    clearQueue: true,
    persistIntentImpl: async () => {},
    requestResetImpl: async () => ({ ok: true, status: "no_active_session" }),
    completeStateImpl: async () => {},
    clearIntentImpl: async () => {},
    logImpl: (line) => lines.push(line),
  });

  assert.deepEqual(lines, ["reset for chat 7091451031: -> no_active_session (token 7091451031::)"]);

  const successes = [];
  await performScopedReset("7091451031:", "7091451031::", {
    persistIntentImpl: async () => {},
    requestResetImpl: async () => ({ ok: true, status: "reset", previousSessionId: "wrun_1" }),
    completeStateImpl: async () => {},
    clearIntentImpl: async () => {},
    logImpl: (line) => successes.push(line),
  });
  assert.deepEqual(successes, ["reset for chat 7091451031: -> reset (token 7091451031::)"]);
});

test("intent reconciliation logs its reset outcome too", async () => {
  await persistPrivateResetIntent("429888768:", "telegram:429888768::");
  const lines = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async () => ({ ok: true, status: "reset" }),
    logImpl: (line) => lines.push(line),
  });

  assert.deepEqual(lines, ["reset for chat 429888768: -> reset (token 429888768::)"]);
});
