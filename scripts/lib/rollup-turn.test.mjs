import test from "node:test";
import assert from "node:assert/strict";
import {
  canRetryFresh,
  cancelTurnQuietly,
  DEFAULT_TURN_TIMEOUT_MS,
  RollupTurnTimeoutError,
  resolveTurnTimeoutMs,
  withTurnTimeout,
} from "./rollup-turn.mjs";

test("fresh retry requires an unaccepted turn or confirmed cancellation", () => {
  assert.equal(canRetryFresh({ accepted: false, cancelConfirmed: false }), true);
  assert.equal(canRetryFresh({ accepted: false, cancelConfirmed: true }), true);
  assert.equal(canRetryFresh({ accepted: true, cancelConfirmed: false }), false);
  assert.equal(canRetryFresh({ accepted: true, cancelConfirmed: true }), true);
});

async function countSendsThroughRetryPolicy({ firstSend, cancel }) {
  let sends = 0;
  let accepted = false;
  try {
    const response = await firstSend(() => {
      sends += 1;
    });
    accepted = true;
    await withTurnTimeout(() => response.result(), { timeoutMs: 20, label: "main-turn" });
  } catch {
    const cancelConfirmed = accepted ? await cancel() : false;
    if (canRetryFresh({ accepted, cancelConfirmed })) sends += 1;
  }
  return sends;
}

test("an accepted hung turn with refused cancellation never sends a fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: async (recordSend) => {
      recordSend();
      return { result: () => new Promise(() => {}) };
    },
    cancel: async () => false,
  });
  assert.equal(sends, 1);
});

test("a rejected send gets exactly one fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: async (recordSend) => {
      recordSend();
      throw new Error("session gone");
    },
    cancel: async () => {
      throw new Error("cancel must not be called for an unaccepted turn");
    },
  });
  assert.equal(sends, 2);
});

test("a turn that finishes in time returns its result", async () => {
  const result = await withTurnTimeout(async () => "report", { timeoutMs: 50, label: "main-turn" });
  assert.equal(result, "report");
});

test("a hung turn rejects with a labelled timeout error", async () => {
  await assert.rejects(
    withTurnTimeout(() => new Promise(() => {}), { timeoutMs: 20, label: "main-turn" }),
    (e) => {
      assert.ok(e instanceof RollupTurnTimeoutError);
      assert.equal(e.code, "ROLLUP_TURN_TIMEOUT");
      assert.equal(e.label, "main-turn");
      return true;
    },
  );
});

test("the timer is cleared, so the next turn runs right after a win", async () => {
  assert.equal(await withTurnTimeout(async () => 1, { timeoutMs: DEFAULT_TURN_TIMEOUT_MS, label: "first" }), 1);
  assert.equal(await withTurnTimeout(async () => 2, { timeoutMs: DEFAULT_TURN_TIMEOUT_MS, label: "second" }), 2);
  // Файл теста завершается сам: незачищенный 10-минутный таймер держал бы event loop.
});

test("the configured timeout is taken only when it is a sane millisecond count", () => {
  assert.equal(resolveTurnTimeoutMs("60000"), 60000);
  assert.equal(resolveTurnTimeoutMs(undefined), DEFAULT_TURN_TIMEOUT_MS);
});

test("a malformed timeout falls back to the default and warns", () => {
  // Пустое значение и мусор дают Number() → 0/NaN: без разбора это был бы таймер на 1 мс,
  // то есть мгновенно «зависший» ход на каждой ночи.
  for (const raw of ["", "  ", "abc", "0", "-1", "1.5", String(2 ** 31)]) {
    const warnings = [];
    assert.equal(resolveTurnTimeoutMs(raw, { warn: (m) => warnings.push(m) }), DEFAULT_TURN_TIMEOUT_MS);
    if (raw.trim() !== "") assert.equal(warnings.length, 1, `expected a warning for ${JSON.stringify(raw)}`);
  }
});

test("a hung cancel is swallowed instead of blocking the retry", async () => {
  const session = { cancel: () => new Promise(() => {}) };
  assert.equal(await cancelTurnQuietly(session, { timeoutMs: 30 }), false);
});

test("a refused cancel is swallowed too", async () => {
  // Не начатая сессия бросает синхронно, заклинившая может ответить 500 — оба исхода не наши.
  const throws = { cancel: () => { throw new Error("session has not started"); } };
  const rejects = { cancel: async () => { throw new Error("500 cancel-turn"); } };
  assert.equal(await cancelTurnQuietly(throws, { timeoutMs: 30 }), false);
  assert.equal(await cancelTurnQuietly(rejects, { timeoutMs: 30 }), false);
});

test("an accepted cancel reports success", async () => {
  const session = { cancel: async () => ({ status: "accepted" }) };
  assert.equal(await cancelTurnQuietly(session, { timeoutMs: 30 }), true);
});
