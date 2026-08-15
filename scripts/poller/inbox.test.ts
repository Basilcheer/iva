import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  createQueueItem,
  enqueueItem,
  removeQueueHead,
  type TelegramQueueDocument,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  admitMessageUpdate,
  promoteReadyInbox,
  selectReadyInboxBatch,
} from "./inbox.ts";

const SEED = 18_702;

function update(updateId: number, text: string): TelegramQueueUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text,
    },
  };
}

function inboxDocument(
  ...updates: TelegramQueueUpdate[]
): TelegramQueueDocument {
  return updates.reduce<TelegramQueueDocument>(
    (document, candidate, index) =>
      enqueueItem(document, "1::42", createQueueItem(candidate, index * 100))
        .document,
    { version: 1, queues: {} },
  );
}

void test("durable inbox waits for quiet and then merges the owned burst", () => {
  const document = inboxDocument(update(101, "first"), update(102, "second"));
  assert.equal(
    selectReadyInboxBatch("1::42", document.queues["1::42"], 899, {
      quietMs: 800,
    }),
    null,
  );
  const batch = selectReadyInboxBatch("1::42", document.queues["1::42"], 900, {
    quietMs: 800,
  });
  assert.ok(batch?.update.message?.iva_parts);
  assert.equal(batch.update.update_id, 102);
  assert.deepEqual(batch.updateIds, [101, 102]);
  assert.deepEqual(
    batch.update.message.iva_parts.map((part) => part.text),
    ["first", "second"],
  );
});

void test("property: durable reconstruction returns the exact ready prefix", () => {
  fc.assert(
    fc.property(
      fc
        .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 10,
        })
        .map((ids) => ids.sort((left, right) => left - right)),
      fc.integer({ min: 0, max: 500 }),
      (updateIds, quietMs) => {
        const document = inboxDocument(
          ...updateIds.map((updateId) => update(updateId, `part-${updateId}`)),
        );
        const batch = selectReadyInboxBatch(
          "1::42",
          document.queues["1::42"],
          (updateIds.length - 1) * 100 + quietMs,
          { quietMs },
        );
        assert.ok(batch);
        const expectedIds = quietMs === 0 ? updateIds.slice(0, 1) : updateIds;
        assert.deepEqual(batch.updateIds, expectedIds);
        assert.equal(batch.update.update_id, Math.max(...expectedIds));
      },
    ),
    { seed: SEED, numRuns: 1_000 },
  );
});

void test("promotion publishes the delivery item before removing raw ownership", async () => {
  let document = inboxDocument(update(101, "first"), update(102, "second"));
  const events: string[] = [];
  const remaining = await promoteReadyInbox({
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate) => {
      events.push(`route:${candidate.update_id}`);
      return Promise.resolve("queued");
    },
    acknowledgeImpl: (key, updateId) => {
      events.push(`ack:${updateId}`);
      document = removeQueueHead(document, key, updateId);
      return Promise.resolve();
    },
  });

  assert.equal(remaining, 0);
  assert.deepEqual(events, ["route:102", "ack:101", "ack:102"]);
});

void test("failed promotion keeps every raw part for retry", async () => {
  const document = inboxDocument(update(101, "first"), update(102, "second"));
  let acknowledgements = 0;
  assert.equal(
    await promoteReadyInbox({
      now: () => 1_000,
      collectorOptions: { quietMs: 800 },
      loadImpl: () => Promise.resolve(document),
      routeImpl: () => Promise.resolve("enqueue-failed"),
      acknowledgeImpl: () => {
        acknowledgements++;
        return Promise.resolve();
      },
    }),
    2,
  );
  assert.equal(acknowledgements, 0);
});

void test("admission owns trusted input and drops group noise before any offset may move", async () => {
  const owned: Array<[string, number]> = [];
  assert.equal(
    await admitMessageUpdate(update(101, "private"), {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  const noise = update(102, "group noise");
  assert.ok(noise.message);
  noise.message.chat = { id: -100, type: "supergroup" };
  assert.equal(
    await admitMessageUpdate(noise, {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: () => assert.fail("noise must not be persisted"),
    }),
    "dropped",
  );
  assert.deepEqual(owned, [["1::42", 101]]);
});
