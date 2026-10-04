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

type Outcome = "accepted" | "gone" | "throws";
/** Один ход: шаги, затем turn.completed. Возвращает, ушла ли просьба и была ли принята. */
async function turn(
  sessionId: string,
  steps: readonly (number | null)[],
  outcome: Outcome = "accepted",
  chatKey = `${sessionId}:`,
) {
  idle.openIdleCompactionTurn(sessionId);
  for (const tokens of steps) idle.recordStepInput(sessionId, tokens);
  let asked = false;
  const accepted = await idle.compactIdleSession({
    sessionId,
    chatKey,
    windowTokens: WINDOW,
    requestImpl: async () => {
      asked = true;
      if (outcome === "throws") throw new Error("route is down");
      return outcome === "accepted";
    },
    logImpl: () => {},
  });
  return { asked, accepted };
}

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
      const idle = idleCompactionLimit(window);
      const inTurn = compactionThresholdPercent(window) * window;
      assert.ok(idle <= IDLE_COMPACTION_MAX_TOKENS && idle <= window * 0.6);
      assert.ok(inTurn > idle, "страховка выше свёртки между ходами");
      assert.ok(inTurn <= window * 0.75 + 1e-6, "и оставляет запас до окна");
    }),
  );
});

test("шаг ниже порога не сворачивает, шаг на пороге просит свёртку", async () => {
  const id = fresh();
  assert.deepEqual(await turn(id, [LIMIT - 1]), {
    asked: false,
    accepted: false,
  });
  assert.deepEqual(await turn(id, [LIMIT]), { asked: true, accepted: true });
});

test("решает вход последнего шага хода, а не первого", async () => {
  assert.equal((await turn(fresh(), [LIMIT + 5, LIMIT - 1])).asked, false);
  assert.equal((await turn(fresh(), [10, LIMIT])).asked, true);
});

test("неизвестный вход последнего шага и сессия без turn.started свёртку не просят", async () => {
  assert.equal((await turn(fresh(), [LIMIT, null])).asked, false);
  const id = fresh();
  idle.recordStepInput(id, LIMIT * 2);
  let asked = false;
  await idle.compactIdleSession({
    sessionId: id,
    chatKey: "bg:",
    windowTokens: WINDOW,
    requestImpl: async () => (asked = true),
  });
  assert.equal(asked, false);
});

test("законченная свёртка, после которой первый шаг всё ещё за порогом, выключает себя до конца сессии", async () => {
  const id = fresh();
  assert.equal((await turn(id, [LIMIT])).accepted, true);
  idle.completeIdleCompaction(id);
  assert.equal((await turn(id, [LIMIT, LIMIT + 10])).asked, false);
  assert.equal((await turn(id, [LIMIT * 2])).asked, false, "и дальше молчит");
});

test("свёртка помогла: первый шаг под порогом, следующий перебор сворачивает снова", async () => {
  const id = fresh();
  await turn(id, [LIMIT]);
  idle.completeIdleCompaction(id);
  assert.equal((await turn(id, [LIMIT - 100, LIMIT + 1])).asked, true);
});

test("оборванная свёртка (нет compaction.completed) ничего не выключает", async () => {
  const id = fresh();
  await turn(id, [LIMIT]);
  assert.equal((await turn(id, [LIMIT, LIMIT])).asked, true);
});

test("отказ роута и исчезнувшая сессия ход не роняют и подпись не оставляют", async () => {
  for (const outcome of ["throws", "gone"] as const) {
    const id = fresh();
    assert.deepEqual(await turn(id, [LIMIT], outcome), {
      asked: true,
      accepted: false,
    });
    assert.equal(idle.idleCompactionRunning(`${id}:`), false);
    assert.equal((await turn(id, [LIMIT])).asked, true, "следующий ход просит");
  }
});

test("подпись держится от просьбы до compaction.completed, начала хода или срока", async () => {
  const id = fresh();
  const chatKey = `${id}:`;
  assert.equal(idle.idleCompactionRunning(chatKey), false);
  await turn(id, [LIMIT]);
  assert.equal(idle.idleCompactionRunning(chatKey), true);
  idle.completeIdleCompaction(id);
  assert.equal(idle.idleCompactionRunning(chatKey), false);

  await turn(id, [10, LIMIT]);
  assert.equal(idle.idleCompactionRunning(chatKey), true);
  idle.openIdleCompactionTurn(id);
  assert.equal(idle.idleCompactionRunning(chatKey), false, "ход начался");

  const late = fresh();
  await turn(late, [LIMIT]);
  const at = Date.now();
  assert.equal(
    idle.idleCompactionRunning(`${late}:`, at + idle.IDLE_COMPACTION_NOTE_MS),
    false,
    "свёртка без конца подпись дольше срока не держит",
  );
});

test("подпись видна уже пока eve принимает просьбу, и только в своём чате", async () => {
  const id = fresh();
  idle.openIdleCompactionTurn(id);
  idle.recordStepInput(id, LIMIT);
  let during: boolean[] = [];
  await idle.compactIdleSession({
    sessionId: id,
    chatKey: "chat-a:",
    windowTokens: WINDOW,
    requestImpl: async () => {
      during = [
        idle.idleCompactionRunning("chat-a:"),
        idle.idleCompactionRunning("chat-b:"),
      ];
      return true;
    },
  });
  assert.deepEqual(during, [true, false]);
});

type Turn = {
  first: number | null;
  last: number | null;
  outcome: Outcome;
  completes: boolean;
};
const tokens = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 0, max: WINDOW * 2 }),
  fc.constantFrom(LIMIT - 1, LIMIT, LIMIT + 1),
);
const turnArb: fc.Arbitrary<Turn> = fc.record({
  first: tokens,
  last: tokens,
  outcome: fc.constantFrom<Outcome>("accepted", "gone", "throws"),
  completes: fc.boolean(),
});

test("property: просьба уходит только за порогом, не бросает и после бесполезной свёртки не повторяется", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(turnArb, { maxLength: 30 }), async (script) => {
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
        const expected: boolean =
          !off && step.last !== null && step.last >= LIMIT;
        const result = await turn(id, [step.first, step.last], step.outcome);
        assert.equal(result.asked, expected);
        assert.equal(result.accepted, expected && step.outcome === "accepted");
        assert.equal(idle.idleCompactionRunning(`${id}:`), result.accepted);
        if (result.accepted) {
          asked = true;
          if (step.completes) {
            idle.completeIdleCompaction(id);
            compacted = true;
            assert.equal(idle.idleCompactionRunning(`${id}:`), false);
          }
        }
      }
    }),
  );
});
