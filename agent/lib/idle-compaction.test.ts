/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; request doubles keep the async boundary. */
// Свёртка между ходами: когда канал просит eve пересказать историю и когда перестаёт.
//
// КАК ВОСПРОИЗВЕСТИ: при провале fast-check печатает seed и path; передать их вторым
// аргументом fc.assert(prop, { seed, path }), прогон повторится байт в байт.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  compactionThresholdPercent,
  IDLE_COMPACTION_MAX_TOKENS,
  IDLE_COMPACTION_PERCENT,
  idleCompactionLimit,
} from "./compaction.ts";
import * as idle from "./idle-compaction.ts";

const WINDOW = 100_000;
const LIMIT = idleCompactionLimit(WINDOW);
let seq = 0;
const fresh = () => `s-${++seq}`;

/** Один ход: turn.started → шаги → turn.completed. */
function turn(
  sessionId: string,
  steps: readonly (number | null)[],
  inTurnCompaction = false,
) {
  idle.openIdleCompactionTurn(sessionId);
  for (const tokens of steps) idle.recordStepInput(sessionId, tokens);
  // Страховка eve внутри хода шлёт то же compaction.completed.
  if (inTurnCompaction) idle.completeIdleCompaction(sessionId);
  idle.closeIdleCompactionTurn(sessionId, WINDOW);
}

type Outcome = "accepted" | "gone" | "throws";
/** session.waiting: что сделал канал. */
async function waiting(
  sessionId: string,
  {
    outcome = "accepted",
    chatFree = true,
  }: { outcome?: Outcome; chatFree?: boolean } = {},
) {
  const seen = { claimed: false, asked: false, released: false };
  const accepted = await idle.startIdleCompaction({
    sessionId,
    claimImpl: () => {
      seen.claimed = true;
      return chatFree;
    },
    requestImpl: async () => {
      seen.asked = true;
      if (outcome === "throws") throw new Error("route is down");
      return outcome === "accepted";
    },
    releaseImpl: async () => {
      seen.released = true;
    },
    logImpl: () => {},
  });
  return { ...seen, accepted };
}
const NOTHING = {
  claimed: false,
  asked: false,
  released: false,
  accepted: false,
};
const ASKED = { claimed: true, asked: true, released: false, accepted: true };

test("порог — 60 % окна, но не больше 275 тыс. токенов; страховка внутри хода на четверть выше", () => {
  assert.equal(IDLE_COMPACTION_PERCENT, 0.6);
  assert.equal(IDLE_COMPACTION_MAX_TOKENS, 275_000);
  assert.equal(idleCompactionLimit(100_000), 60_000);
  assert.equal(idleCompactionLimit(131_072), 78_643);
  assert.equal(idleCompactionLimit(272_000), 163_200);
  assert.equal(idleCompactionLimit(1_000_000), 275_000);
  assert.equal(compactionThresholdPercent(100_000), 0.75);
  assert.equal(compactionThresholdPercent(1_000_000), 0.34375);
  fc.assert(
    fc.property(fc.integer({ min: 1_000, max: 5_000_000 }), (window) => {
      const limit = idleCompactionLimit(window);
      const inTurn = compactionThresholdPercent(window) * window;
      assert.ok(limit <= IDLE_COMPACTION_MAX_TOKENS && limit <= window * 0.6);
      assert.ok(inTurn > limit, "страховка выше свёртки между ходами");
      assert.ok(inTurn <= window * 0.75 + 1e-6, "и оставляет запас до окна");
    }),
  );
});

test("ход под порогом ничего не просит, ход на пороге занимает чат и просит пересказ", async () => {
  const id = fresh();
  turn(id, [LIMIT - 1]);
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("решает вход последнего шага хода, а не первого", async () => {
  const low = fresh();
  turn(low, [LIMIT + 5, LIMIT - 1]);
  assert.deepEqual(await waiting(low), NOTHING);
  const high = fresh();
  turn(high, [10, LIMIT]);
  assert.deepEqual(await waiting(high), ASKED);
});

test("неизвестный вход последнего шага и сессия без turn.started пересказ не просят", async () => {
  const unknown = fresh();
  turn(unknown, [LIMIT, null]);
  assert.deepEqual(await waiting(unknown), NOTHING);
  const background = fresh();
  idle.recordStepInput(background, LIMIT * 2);
  idle.closeIdleCompactionTurn(background, WINDOW);
  assert.deepEqual(await waiting(background), NOTHING);
});

test("на один законченный ход одна просьба: второй session.waiting (конец пересказа) молчит", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
  assert.deepEqual(await waiting(id), NOTHING);
  assert.deepEqual(await waiting(id), NOTHING);
});

test("чат уже занят (успело прийти сообщение): просьбы нет, и этот ход её больше не повторяет", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id, { chatFree: false }), {
    ...NOTHING,
    claimed: true,
  });
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id), ASKED, "следующий ход решает заново");
});

test("начавшийся ход снимает решение прошлого хода", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  idle.openIdleCompactionTurn(id);
  assert.deepEqual(await waiting(id), NOTHING);
});

test("законченный пересказ, после которого первый шаг всё ещё на пороге, выключает свёртку до конца сессии", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT, LIMIT + 10]);
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT * 2]);
  assert.deepEqual(await waiting(id), NOTHING, "и дальше молчит");
});

test("пересказ помог: первый шаг под порогом, следующий перебор сворачивает снова", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT - 100, LIMIT + 1]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("оборванный пересказ (нет compaction.completed) ничего не выключает", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("пересказ страховки внутри хода — не наш: оборванная свёртка плюс страховка не выключают", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id); // просьба принята, но пересказ оборвало сообщение
  turn(id, [LIMIT, LIMIT + 1], true); // в этом ходе сработала страховка eve
  assert.deepEqual(await waiting(id), ASKED, "свёртка между ходами жива");
});

test("отказ роута и исчезнувшая сессия: чат освобождён, наружу ничего не летит, следующий ход просит снова", async () => {
  for (const outcome of ["throws", "gone"] as const) {
    const id = fresh();
    turn(id, [LIMIT]);
    assert.deepEqual(await waiting(id, { outcome }), {
      claimed: true,
      asked: true,
      released: true,
      accepted: false,
    });
    turn(id, [LIMIT, LIMIT]);
    assert.deepEqual(await waiting(id), ASKED, "отказ не считается пересказом");
  }
});

test("сбой занятия и сбой освобождения чата наружу не летят", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  const boom = () => {
    throw new Error("run-status lock timeout");
  };
  assert.equal(
    await idle.startIdleCompaction({
      sessionId: id,
      claimImpl: boom,
      requestImpl: async () => true,
      releaseImpl: async () => boom(),
      logImpl: () => {},
    }),
    false,
  );
});

type Step = {
  first: number | null;
  last: number | null;
  inTurn: boolean;
  chatFree: boolean;
  outcome: Outcome;
  completes: boolean;
};
const tokens = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 0, max: WINDOW * 2 }),
  fc.constantFrom(LIMIT - 1, LIMIT, LIMIT + 1),
);
const stepArb: fc.Arbitrary<Step> = fc.record({
  first: tokens,
  last: tokens,
  inTurn: fc.boolean(),
  chatFree: fc.boolean(),
  outcome: fc.constantFrom<Outcome>("accepted", "gone", "throws"),
  completes: fc.boolean(),
});

test("property: просьба уходит только за порогом и в свободный чат, раз на ход, и после бесполезного пересказа не повторяется", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(stepArb, { maxLength: 30 }), async (script) => {
      const id = fresh();
      let off = false;
      let asked = false;
      let compacted = false;
      for (const step of script) {
        if (asked) {
          if (compacted && step.first !== null && step.first >= LIMIT)
            off = true;
          asked = false;
          compacted = false;
        }
        turn(id, [step.first, step.last], step.inTurn);
        const due: boolean = !off && step.last !== null && step.last >= LIMIT;
        const result = await waiting(id, step);
        assert.equal(result.claimed, due);
        assert.equal(result.asked, due && step.chatFree);
        const accepted: boolean =
          due && step.chatFree && step.outcome === "accepted";
        assert.equal(result.accepted, accepted);
        assert.equal(result.released, due && step.chatFree && !accepted);
        assert.deepEqual(await waiting(id, step), NOTHING, "вторая парковка");
        if (accepted) {
          asked = true;
          if (step.completes) {
            idle.completeIdleCompaction(id);
            compacted = true;
          }
        }
      }
    }),
  );
});
