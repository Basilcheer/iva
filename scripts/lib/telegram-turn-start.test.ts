import test from "node:test";
import assert from "node:assert/strict";

import {
  emitTelegramTurnLatency,
  markTelegramFirstOutput,
  publishTelegramEarlyStatus,
  publishTelegramTurnStarted,
} from "./telegram-turn-start.ts";

type Status = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function statusStore(initial: Status = {}) {
  let value = initial;
  return {
    get: () => value,
    set: (_key: string, patch: Status) => {
      value = { ...value, ...patch };
      for (const key of Object.keys(value))
        if (value[key] === null) delete value[key];
      return value;
    },
    cas: (_key: string, expected: Status, patch: Status) => {
      if (
        Object.entries(expected).some(
          ([key, expectedValue]) => !Object.is(value[key], expectedValue),
        )
      ) {
        return null;
      }
      value = { ...value, ...patch };
      for (const key of Object.keys(value))
        if (value[key] === null) delete value[key];
      return value;
    },
  };
}

void test("a trusted dispatch creates one status before a fake 20-second pre-turn delay and turn.started adopts it", async () => {
  const events: string[] = [];
  const store = statusStore({ status: "idle" });
  let nowMs = 1_000;
  let sends = 0;
  const stopEnabled: boolean[] = [];

  await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-1",
    now: () => nowMs++,
    setStatusImpl: store.set,
    setStatusIfImpl: store.cas,
    sendWorkingStatusImpl: (options) => {
      sends++;
      stopEnabled.push(options.canStop);
      events.push("working-status");
      return Promise.resolve(77);
    },
  });
  events.push("provider-work");
  nowMs += 20_000;

  const adopted = await publishTelegramTurnStarted({
    chatKey: "1:",
    continuationToken: "1::",
    sessionId: "session-1",
    turnId: "turn-1",
    now: () => nowMs,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
    enableWorkingStatusStopImpl: (messageId) => {
      assert.equal(messageId, 77);
      stopEnabled.push(true);
      return Promise.resolve();
    },
  });

  assert.equal(adopted, true);
  assert.equal(sends, 1);
  assert.deepEqual(stopEnabled, [false, true]);
  assert.deepEqual(events, ["working-status", "provider-work"]);
  assert.equal(store.get().statusMessageId, 77);
  assert.equal(store.get().sessionId, "session-1");
  assert.equal(store.get().turnId, "turn-1");
  assert.equal(store.get().ingressAt, 1_000);
  assert.equal(store.get().statusAt, 1_001);
  assert.equal(store.get().turnAt, 21_002);
});

void test("working-status failure never blocks turn adoption", async () => {
  const store = statusStore({ status: "idle" });
  const errors: string[] = [];

  await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-1",
    setStatusImpl: store.set,
    setStatusIfImpl: store.cas,
    sendWorkingStatusImpl: () =>
      Promise.reject(new Error("Telegram unavailable")),
    onWorkingStatusError: (error) =>
      errors.push(error instanceof Error ? error.message : String(error)),
  });
  const adopted = await publishTelegramTurnStarted({
    chatKey: "1:",
    continuationToken: "1::",
    sessionId: "session-1",
    turnId: "turn-1",
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(adopted, true);
  assert.deepEqual(errors, ["Telegram unavailable"]);
  assert.equal(store.get().sessionId, "session-1");
  assert.equal(store.get().statusMessageId, undefined);
});

void test("a reset racing a late early-status response cannot revive the old session", async () => {
  const working = deferred<number>();
  const store = statusStore({ status: "idle" });
  const removed: number[] = [];

  const publishing = publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-1",
    setStatusImpl: store.set,
    setStatusIfImpl: store.cas,
    sendWorkingStatusImpl: () => working.promise,
    removeWorkingStatusImpl: (messageId) => {
      removed.push(messageId);
      return Promise.resolve();
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  store.set("1:", {
    status: "idle",
    ingressId: null,
    sessionId: null,
    turnId: null,
    resetAt: 2_000,
  });
  working.resolve(78);
  await publishing;
  const adopted = await publishTelegramTurnStarted({
    chatKey: "1:",
    continuationToken: "1::",
    sessionId: "session-old",
    turnId: "turn-old",
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(adopted, false);
  assert.deepEqual(removed, [78]);
  assert.equal(store.get().status, "idle");
  assert.equal(store.get().sessionId, undefined);
});

void test("latency logging emits one allowlisted JSON record with no sensitive fields", () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-secret",
    ingressAt: 1_000,
    statusAt: 1_010,
    turnAt: 1_100,
    prompt: "private prompt",
    userId: "123456",
    token: "bot-token",
  });
  const lines: string[] = [];
  assert.equal(
    markTelegramFirstOutput({
      chatKey: "1:",
      sessionId: "session-secret",
      now: () => 1_500,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    true,
  );
  assert.equal(
    markTelegramFirstOutput({
      chatKey: "1:",
      sessionId: "session-secret",
      now: () => 1_600,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    false,
  );
  const options = {
    chatKey: "1:",
    sessionId: "session-secret",
    deliveryAt: 1_700,
    delivered: true,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
    logImpl: (line: string) => lines.push(line),
  };

  assert.equal(
    emitTelegramTurnLatency({ ...options, delivered: false }),
    false,
  );
  assert.equal(store.get().latencyLogged, undefined);
  assert.equal(emitTelegramTurnLatency(options), true);
  assert.equal(emitTelegramTurnLatency(options), false);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "telegram_turn_latency",
    ingressToStatusMs: 10,
    ingressToTurnMs: 100,
    ingressToFirstOutputMs: 500,
    ingressToDeliveryMs: 700,
  });
  assert.doesNotMatch(
    lines[0],
    /private prompt|123456|bot-token|session-secret|1:/,
  );
});

void test("a namespaced token from Eve is stored channel-local (#110)", async () => {
  // Реальное значение с прода: обработчики событий eve отдают токен с именем канала
  // впереди. Если сохранить его как есть, /new сбрасывает "telegram:telegram:…" —
  // владельца нет, ответ no_active_session, история продолжается.
  const claimed = statusStore({ status: "idle" });
  assert.equal(
    await publishTelegramTurnStarted({
      chatKey: "7091451031:",
      continuationToken: "telegram:7091451031::",
      sessionId: "session-1",
      turnId: "turn-1",
      getStatusImpl: claimed.get,
      setStatusIfImpl: claimed.cas,
    }),
    true,
  );
  assert.equal(claimed.get().continuationToken, "7091451031::");

  // Второй путь записи — усыновление хода, начатого ранним статусом моста.
  const adopted = statusStore({ status: "idle" });
  await publishTelegramEarlyStatus({
    chatKey: "-1001:77",
    ingressId: "ingress-1",
    setStatusImpl: adopted.set,
    setStatusIfImpl: adopted.cas,
    sendWorkingStatusImpl: () => Promise.resolve(null),
  });
  assert.equal(
    await publishTelegramTurnStarted({
      chatKey: "-1001:77",
      continuationToken: "telegram:-1001:77:42",
      sessionId: "session-2",
      turnId: "turn-2",
      getStatusImpl: adopted.get,
      setStatusIfImpl: adopted.cas,
    }),
    true,
  );
  assert.equal(adopted.get().continuationToken, "-1001:77:42");
});
