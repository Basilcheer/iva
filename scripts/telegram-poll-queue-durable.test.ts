/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns top-level registrations; injected test doubles preserve the asynchronous runtime contracts. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  TelegramQueueDocument,
  TelegramQueueUpdate,
} from "./lib/telegram-queue.ts";

type HarnessMessage = {
  message_id: number;
  text?: string;
  message_thread_id?: number;
  chat: { id: number };
  iva_parts?: Array<{ message_id: number; text?: string }>;
  iva_durable_queue_receipt?: unknown;
};
type HarnessUpdate = TelegramQueueUpdate & {
  message?: HarnessMessage;
  callback_query?: { id: string };
};
type HarnessResult = {
  offset: { offset: number; delivered?: number };
  deliveries: HarnessUpdate[];
  deliveryRoutes: string[];
  reactions: unknown[];
  queueStatuses: Array<{ text?: string }>;
  queue: TelegramQueueDocument;
  requestedOffsets: number[];
  queueDirSyncAttempts: number;
  queueDirSyncSuccesses: number;
  statusBeforeRetry: { status: string; ingressId?: unknown };
  deletedMessages: Array<{ chat_id: string; message_id: number }>;
  failureNotices: Array<{ chat_id: string; text: string }>;
  finalStatus: { status: string; ingressId?: unknown };
};
type HarnessOptions = {
  collectQuietMs?: string;
  directAcceptanceTimeoutMs?: string;
};
type ResetRequest = { chatKey: string; continuationToken: string };
type RoutingCall =
  | ["enqueue", string, TelegramQueueUpdate]
  | ["acknowledge", TelegramQueueUpdate, number]
  | ["deliver"];
type FetchCall = { url: string; init: RequestInit | undefined };

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "scripts/fixtures/telegram-poll-queue-harness.ts");
const [queueRuntime, routingRuntime, deliverRuntime] = await Promise.all([
  import("./poller/queue.ts"),
  import("./poller/routing.ts"),
  import("./poller/deliver.ts"),
]);

function makeDataDir(t: TestContext, label: string) {
  const path = mkdtempSync(join(tmpdir(), `iva-008-${label}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function runHarness(
  mode: string,
  dataDir: string,
  fault = "none",
  { collectQuietMs = "0", directAcceptanceTimeoutMs }: HarnessOptions = {},
): HarnessResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, mode, dataDir, fault],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TELEGRAM_COLLECT_QUIET_MS: collectQuietMs,
        ...(directAcceptanceTimeoutMs === undefined
          ? {}
          : {
              TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS: directAcceptanceTimeoutMs,
            }),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `harness failed (${mode}/${fault})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(
    readFileSync(join(dataDir, "queue-harness-result.json"), "utf8"),
  ) as HarnessResult;
}

test("direct queue runtime normalizes a namespaced reset token", async () => {
  const requests: ResetRequest[] = [];
  const result = await queueRuntime.releaseScopedContinuation(
    "1:",
    "telegram:1::",
    {
      requestResetImpl: async (request) => {
        requests.push(request);
        return { ok: true, status: "reset" };
      },
      logImpl: () => {},
    },
  );

  assert.deepEqual(result, { ok: true, status: "reset" });
  assert.deepEqual(requests, [{ chatKey: "1:", continuationToken: "1::" }]);
});

test("direct routing runtime durably queues a busy private update", async () => {
  const update = {
    update_id: 501,
    message: {
      message_id: 501,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text: "follow-up",
    },
  };
  const calls: RoutingCall[] = [];
  const result = await routingRuntime.routeMessageUpdate(update, {
    chatKeyImpl: () => "1:",
    loadQueueImpl: async () => ({ version: 1, queues: {} }),
    runningImpl: () => true,
    inFlight: new Map(),
    queueCountImpl: () => 0,
    replyToBotImpl: () => false,
    shouldQueueImpl: () => true,
    enqueueImpl: async (key, candidate) => {
      calls.push(["enqueue", key, candidate]);
      return { count: 1 };
    },
    acknowledgeImpl: async (candidate, count) => {
      calls.push(["acknowledge", candidate, count]);
    },
    deliverImpl: async () => {
      calls.push(["deliver"]);
      return true;
    },
    logImpl: () => {},
  });

  assert.equal(result, "queued");
  assert.deepEqual(calls, [
    ["enqueue", "1:", update],
    ["acknowledge", update, 1],
  ]);
});

test("direct delivery runtime requires the accepted-route receipt", async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = async (url, init) => {
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: requestUrl, init });
    return new Response(null, {
      status: 204,
      headers: { "x-iva-telegram-acceptance": "turn" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accepted = await deliverRuntime.deliver({
    update_id: 601,
    message: {
      message_id: 601,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text: "hello",
    },
  });

  assert.equal(accepted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/eve\/v1\/telegram\/accepted$/);
});

for (const fault of ["write", "rename"]) {
  test(`busy queue ${fault} failure does not advance Telegram offset`, (t: TestContext) => {
    const dataDir = makeDataDir(t, `disk-${fault}`);
    const result = runHarness("disk-failure", dataDir, fault);

    assert.equal(
      result.offset.offset,
      100,
      "the same Telegram update must be retried until its FIFO item is durable",
    );
    assert.deepEqual(result.deliveries, []);
  });
}

test("directory sync failure requires a durable duplicate retry before offset advances", (t: TestContext) => {
  const dataDir = makeDataDir(t, "dir-sync-retry");
  const result = runHarness("dir-sync-retry", dataDir, "dir-sync-once");

  assert.deepEqual(
    result.requestedOffsets,
    [100, 100, 102],
    "the update must be requested again before its offset is committed",
  );
  assert.equal(result.queueDirSyncAttempts, 2);
  assert.equal(
    result.queueDirSyncSuccesses,
    1,
    "the duplicate retry must repeat the atomic write through a successful parent-dir fsync",
  );
  assert.equal(result.offset.offset, 102);
  assert.equal(result.queue.queues["1:"].length, 1);
  assert.equal(result.queue.queues["1:"][0].updateId, 101);
});

test("queued follow-ups auto-drain in FIFO order when the current turn becomes idle", (t: TestContext) => {
  const dataDir = makeDataDir(t, "auto-drain");
  const result = runHarness("auto-drain", dataDir);

  assert.deepEqual(
    result.deliveries.map((update) => [update.update_id, update.message?.text]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(result.deliveryRoutes, [
    "/eve/v1/telegram/accepted",
    "/eve/v1/telegram/accepted",
  ]);
  assert.deepEqual(
    result.queue,
    { version: 1, queues: {} },
    "accepted FIFO items must be removed only after Eve accepts them",
  );
  assert.deepEqual(
    result.queueStatuses.map((status) => status.text),
    [
      "Queued (1). I'll start it automatically when the current task finishes.",
      "Queued (2). I'll start it automatically when the current task finishes.",
    ],
  );
});

test("collector merges a two-text burst into one durable queue item and delivery", (t: TestContext) => {
  const dataDir = makeDataDir(t, "collect-burst");
  const result = runHarness("collect-burst", dataDir, "none", {
    collectQuietMs: "75",
  });

  assert.equal(result.deliveries.length, 1);
  const delivery = result.deliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.update_id, 102);
  assert.ok(delivery.message);
  assert.ok(delivery.message.iva_parts);
  assert.deepEqual(
    delivery.message.iva_parts.map((part) => [part.message_id, part.text]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  assert.equal(result.reactions.length, 1);
  assert.deepEqual(
    result.queueStatuses.map((status) => status.text),
    ["Queued (1). I'll start it automatically when the current task finishes."],
  );
  assert.deepEqual(result.queue, { version: 1, queues: {} });
});

test("a restarted bridge recovers and drains the persisted FIFO without a third user message", (t: TestContext) => {
  const dataDir = makeDataDir(t, "restart");
  const beforeRestart = runHarness("restart-persist", dataDir);
  assert.equal(
    Object.values(beforeRestart.queue.queues).flat().length,
    2,
    "the first process must leave both busy-time follow-ups durable",
  );

  const afterRestart = runHarness("restart-drain", dataDir);
  assert.deepEqual(
    afterRestart.deliveries.map((update) => [
      update.update_id,
      update.message?.text,
    ]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(afterRestart.queue, { version: 1, queues: {} });
});

test("a persistently failing queue head does not block other chats or Telegram polling", (t: TestContext) => {
  const dataDir = makeDataDir(t, "fair-drain");
  const result = runHarness("fair-drain", dataDir);

  assert.deepEqual(
    result.deliveries.map((update) => {
      assert.ok(update.message);
      return [update.message.chat.id, update.update_id];
    }),
    [
      [1, 101],
      [2, 102],
    ],
    "one failed acceptance attempt must yield to the next chat key",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.queue.queues).map(([key, items]) => [
        key,
        items.map((item) => item.updateId),
      ]),
    ),
    { "1:": [101] },
    "the poison head stays durable while an accepted head is acknowledged",
  );
  assert.deepEqual(
    result.requestedOffsets,
    [100],
    "the bridge must return to getUpdates after a bounded drain pass",
  );
});

test("unaddressed group noise is excluded from a busy conversation FIFO", (t: TestContext) => {
  const dataDir = makeDataDir(t, "group-noise");
  const result = runHarness("group-noise", dataDir);

  assert.equal(result.queue.queues?.["-100:"], undefined);
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(result.reactions, []);
  assert.equal(
    result.offset.offset,
    103,
    "ignored group noise is consumed exactly once",
  );
});

test("busy FIFO routes private, group and forum-topic updates without absorbing group noise", (t: TestContext) => {
  const dataDir = makeDataDir(t, "routing");
  const result = runHarness("routing", dataDir);
  const queues = result.queue.queues;

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(queues).map(([key, items]) => [
        key,
        items.map((item) => [
          item.version,
          item.updateId,
          item.update?.message?.text,
        ]),
      ]),
    ),
    {
      "1:": [[1, 101, "private follow-up"]],
      "-100:": [[1, 103, "@my_bot group follow-up"]],
      "-100:7": [[1, 104, "/task topic follow-up"]],
    },
  );
  const topicQueue = queues["-100:7"];
  assert.ok(topicQueue);
  const topicItem = topicQueue[0];
  assert.ok(topicItem);
  assert.ok(topicItem.update?.message);
  assert.equal(topicItem.update.message.message_thread_id, 7);
  assert.equal(result.offset.offset, 105);
  assert.equal(result.reactions.length, 3);
  assert.equal(result.queueStatuses.length, 3);
});

test("an idle direct message uses one accepted POST and keeps offset semantics", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-success");
  const result = runHarness("direct-success", dataDir);

  assert.equal(result.deliveries.length, 1);
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  const delivery = result.deliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.update_id, 101);
  assert.ok(delivery.message);
  assert.equal(typeof delivery.message.iva_durable_queue_receipt, "string");
  assert.deepEqual(result.offset, { offset: 102, delivered: 101 });
});

test("a direct acceptance 503 resets immediately, notifies once, then retries", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-retry");
  const result = runHarness("direct-retry", dataDir);

  assert.deepEqual(result.deliveryRoutes, [
    "/eve/v1/telegram/accepted",
    "/eve/v1/telegram/accepted",
  ]);
  assert.equal(result.statusBeforeRetry.status, "idle");
  assert.equal(result.statusBeforeRetry.ingressId, undefined);
  assert.deepEqual(result.deletedMessages, [{ chat_id: "1", message_id: 77 }]);
  assert.deepEqual(
    result.failureNotices.map(({ chat_id, text }) => [chat_id, text]),
    [["1", "Couldn't process the message - repeat it or use /new"]],
  );
  assert.deepEqual(result.offset, { offset: 102, delivered: 101 });
});

test("a direct acceptance timeout rejects once and returns to Telegram polling", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-timeout");
  const result = runHarness("direct-timeout", dataDir, "none", {
    directAcceptanceTimeoutMs: "25",
  });

  assert.deepEqual(
    result.deliveryRoutes,
    ["/eve/v1/telegram/accepted"],
    "a timed-out POST must never be repeated because it may still start later",
  );
  assert.deepEqual(result.deletedMessages, [{ chat_id: "1", message_id: 78 }]);
  assert.deepEqual(
    result.failureNotices.map(({ chat_id, text }) => [chat_id, text]),
    [["1", "Couldn't process the message - repeat it or use /new"]],
  );
  assert.equal(result.finalStatus.status, "idle");
  assert.equal(result.finalStatus.ingressId, undefined);
  assert.deepEqual(
    result.requestedOffsets,
    [100, 102],
    "the rejected result must let the main loop advance and poll again",
  );
  assert.deepEqual(result.offset, { offset: 102 });
});

test("callback_query delivery stays on the original webhook route", (t: TestContext) => {
  const dataDir = makeDataDir(t, "callback");
  const result = runHarness("callback", dataDir);

  assert.equal(result.deliveries.length, 1);
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram"]);
  const delivery = result.deliveries[0];
  assert.ok(delivery);
  assert.ok(delivery.callback_query);
  assert.equal(delivery.callback_query.id, "foreign-callback-101");
  assert.deepEqual(result.offset, { offset: 102, delivered: 101 });
});
