import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  NIGHT_CANCEL_MS,
  NIGHT_MAX_INPUT_TOKENS,
  NIGHT_MAX_STEPS,
  NIGHT_RESET_MS,
  nightTurnReader,
  readNightTurn,
  resolveStopAt,
  turnMayBeLive,
  turnSummary,
  turnVerdict,
} from "./rollup-turn.ts";
import { DEFAULT_TIMEOUT_MS, JOB_STOP_GRACE_MS } from "#lib/schedule-runner.ts";
import { execFileSync } from "node:child_process";

// Читатель хода ночи: предел, исход, граница. Шаги несут turnId, stepIndex и usage;
// граница — session.waiting / session.completed / session.failed. Помощники — в конце файла.
const TURN = "turn_night";
let nextId = 0;
const SEED = 20260926;

void test("the summary line proves what the session turn did: its steps, its tokens, and a token ceiling not observed", () => {
  const { turn, observe } = nightTurnReader(() => {});
  observe(started(0));
  observe(completed(0, { inputTokens: 1500 }));
  observe(started(1));
  assert.equal(
    turnSummary(turn, "broken"),
    `turn ${TURN} broken: 2 steps, 1500 input tokens`,
  );
  observe(completed(1, undefined));
  assert.equal(
    turnSummary(turn, "broken"),
    `turn ${TURN} broken: 2 steps, 1500 input tokens (the token ceiling was not observed)`,
  );
  assert.match(
    turnSummary(nightTurnReader(() => {}).turn, "broken"),
    /^turn \(id unknown\) broken: 0 steps/u,
  );
});

void test("an interim session.waiting (authorization pause) is not the end: the turn goes on to its own boundary", async () => {
  const run = await read([
    ...steps(1),
    ev("authorization.required", {
      name: "gws",
      description: "d",
      sequence: 0,
      stepIndex: 1,
      turnId: TURN,
      webhookUrl: "https://x",
    }),
    waiting(),
    ev("authorization.completed", {
      name: "gws",
      outcome: "authorized",
      sequence: 0,
      stepIndex: 1,
      turnId: TURN,
    }),
    ...steps(2).map((event) => event),
    report("после паузы"),
    outcome("turn.completed"),
    waiting(),
  ]);
  assert.equal(run.verdict, "completed");
  assert.equal(run.turn.message, "после паузы");
  // Пауза без продолжения — не конец хода: ход мог остаться живым.
  const paused = await read([...steps(1), waiting()]);
  assert.equal(paused.verdict, "broken");
  assert.equal(turnMayBeLive(paused.turn), true);
});

void test("a transport replay of the same meta.id never doubles the steps of the turn or its tokens", async () => {
  const first = started(0);
  const done = completed(0, { inputTokens: 700 });
  const run = await read([
    first,
    done,
    first,
    done,
    report("ok"),
    outcome("turn.completed"),
    waiting(),
  ]);
  assert.equal(run.turn.steps, 1);
  assert.equal(run.turn.inputTokens, 700);
});

void test("the 121st step.started cancels the turn with its tasks once, and turn.cancelled with session.waiting confirms the cut", async () => {
  const run = await read([
    ...steps(NIGHT_MAX_STEPS),
    started(NIGHT_MAX_STEPS),
    started(NIGHT_MAX_STEPS + 1),
    outcome("turn.cancelled"),
    waiting(),
  ]);
  assert.deepEqual(run.calls, [
    { turnId: TURN, pulledBefore: 2 * NIGHT_MAX_STEPS + 1 },
  ]);
  assert.equal(run.turn.cutRequested, true);
  assert.equal(run.verdict, "cut");
  assert.equal(turnMayBeLive(run.turn), false);
});

void test("the report is the last final message.completed of the turn: tool-call messages are not the report", async () => {
  const run = await read([
    report("черновик"),
    report("зову инструмент", "tool-calls"),
    report("итог"),
    report("ещё инструмент", "tool-calls"),
    outcome("turn.completed"),
    waiting(),
  ]);
  assert.equal(run.turn.message, "итог");
});

// Свойства: при провале fast-check печатает { seed, path } — подставь их вторым
// аргументом fc.assert, и прогон повторится байт в байт.
const NOW = 1_800_000_000_000;

void test("a retried durable step of the turn is never deduplicated: its fresh ids count again toward the cancel", async () => {
  const run = await read([
    started(0),
    completed(0, { inputTokens: NIGHT_MAX_INPUT_TOKENS / 2 }),
    started(0),
    completed(0, { inputTokens: NIGHT_MAX_INPUT_TOKENS / 2 }),
    outcome("turn.cancelled"),
    waiting(),
  ]);
  assert.equal(run.turn.steps, 2);
  assert.equal(
    run.calls.length,
    1,
    "the retried step crossed the token ceiling",
  );
  assert.equal(run.verdict, "cut");
});

// Ход дошёл до конца сам, пока шла отмена по пределу: исход решает граница, а не ответ cancel.
async function cancelRaced(reply: () => Promise<unknown>) {
  const run = await read(
    [
      ...steps(NIGHT_MAX_STEPS),
      started(NIGHT_MAX_STEPS),
      report("успел"),
      outcome("turn.completed"),
      waiting(),
    ],
    canceller(reply),
  );
  assert.equal(run.calls.length, 1);
  assert.equal(run.verdict, "completed", "the turn ended on its own");
  assert.equal(run.turn.message, "успел");
}

void test("a thrown cancel leaves the outcome of the turn to the stream boundary", async () => {
  // Обёртка отмены не бросает: отказ сети приходит строкой статуса.
  await cancelRaced(() => Promise.resolve("failed (socket hang up)"));
});

void test(`a step without usable usage warns once, and the turn is cut by steps only (seed ${SEED})`, async () => {
  const junk = fc.constantFrom(
    undefined,
    null,
    {},
    { inputTokens: -1 },
    { inputTokens: Number.NaN },
    { inputTokens: Infinity },
    { inputTokens: "9000000" },
  );
  await fc.assert(
    fc.asyncProperty(
      junk,
      fc.integer({ min: 1, max: 5 }),
      async (usage, bad) => {
        // Первые bad шагов — с мусором в usage, дальше честные: предупреждение одно на ход.
        const sized = Array.from({ length: NIGHT_MAX_STEPS }, (_, i) => [
          started(i),
          completed(i, i < bad ? usage : { inputTokens: 10 }),
        ]).flat();
        const run = await read([
          ...sized,
          started(NIGHT_MAX_STEPS),
          outcome("turn.cancelled"),
          waiting(),
        ]);
        assert.equal(run.turn.tokensSeen, false);
        assert.equal(
          run.log.filter((line) => line.includes("without usable usage"))
            .length,
          1,
        );
        assert.equal(run.calls.length, 1, "the step ceiling still cuts");
        assert.equal(run.verdict, "cut");
      },
    ),
    { seed: SEED, numRuns: 40 },
  );
});

void test("an exception in the own event handling of the client is one returned error, not thrown past the owner and not swallowed", async () => {
  const hostile = {
    get type(): string {
      throw new Error("handler blew up");
    },
  };
  const run = await readNightTurn(
    feed([started(0), hostile]),
    () => Promise.resolve(),
    () => {},
  );
  assert.match(String(run.error), /handler blew up/u);
  assert.equal(turnVerdict(run.turn, run.error), "broken");
});

void test("a stream that ends without a boundary, or throws instead, is a broken turn with a cancel still due", async () => {
  const ended = await read([...steps(4)]);
  assert.equal(ended.verdict, "broken");
  assert.equal(turnMayBeLive(ended.turn), true);
  async function* broken() {
    yield await Promise.resolve(started(0));
    throw new Error("stream disconnected");
  }
  const thrown = await readNightTurn(
    broken(),
    () => Promise.resolve(),
    () => {},
  );
  assert.match(String(thrown.error), /stream disconnected/u);
  assert.equal(turnVerdict(thrown.turn, thrown.error), "broken");
  assert.equal(thrown.turn.steps, 1, "what was read before the break stays");
});

void test("events of a foreign turn are not counted, never cancel the turn and are no error: one log line with its turnId", async () => {
  assert.notEqual(TURN, "turn_foreign");
  const run = await read([
    ev("turn.started", { turnId: TURN }),
    ...steps(2),
    started(NIGHT_MAX_STEPS + 5, "turn_foreign"),
    completed(9, { inputTokens: NIGHT_MAX_INPUT_TOKENS }, "turn_foreign"),
    ev("message.completed", {
      finishReason: "stop",
      message: "чужой",
      sequence: 0,
      stepIndex: 9,
      turnId: "turn_foreign",
    }),
    ev("turn.completed", { sequence: 0, turnId: "turn_foreign" }),
    report("свой"),
    outcome("turn.completed"),
    waiting(),
  ]);
  assert.deepEqual(run.calls, []);
  assert.equal(run.turn.steps, 2);
  assert.equal(run.turn.message, "свой");
  assert.equal(
    run.log.filter((line) => line.includes("foreign turn turn_foreign")).length,
    1,
  );
});

void test(`the reader cancels the turn at most once, exactly when its step index or its token sum crosses the ceiling (seed ${SEED})`, () => {
  const stepEvent = fc.record({
    kind: fc.constantFrom("started", "completed"),
    index: fc.integer({ min: 0, max: NIGHT_MAX_STEPS + 3 }),
    tokens: fc.integer({ min: 0, max: NIGHT_MAX_INPUT_TOKENS / 4 }),
    id: fc.integer({ min: 0, max: 30 }),
  });
  fc.assert(
    fc.property(fc.array(stepEvent, { maxLength: 60 }), (events) => {
      const { turn, observe } = nightTurnReader(() => {});
      let asks = 0;
      const seen = new Set<number>();
      let crossed = false;
      let tokens = 0;
      for (const { kind, index, tokens: used, id } of events) {
        const raw =
          kind === "started"
            ? ev(
                "step.started",
                { stepIndex: index, turnId: TURN, sequence: 0 },
                `id_${id}`,
              )
            : ev(
                "step.completed",
                {
                  stepIndex: index,
                  turnId: TURN,
                  sequence: 0,
                  usage: { inputTokens: used },
                },
                `id_${id}`,
              );
        if (observe(raw)) {
          asks += 1;
          turn.cutRequested = true;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        if (kind === "started" && index >= NIGHT_MAX_STEPS) crossed = true;
        if (kind === "completed") tokens += used;
        if (tokens >= NIGHT_MAX_INPUT_TOKENS) crossed = true;
      }
      assert.equal(asks, crossed ? 1 : 0);
      assert.equal(
        turn.steps,
        events.filter(
          (e, i) =>
            e.kind === "started" &&
            events.findIndex((f) => f.id === e.id) === i,
        ).length,
      );
    }),
    { seed: SEED, numRuns: 300 },
  );
});

void test("session.completed is a stream boundary too, and session.failed is a terminal one that needs no cancel", async () => {
  const done = await read([
    ...steps(2),
    report("ok"),
    outcome("turn.completed"),
    ev("session.completed"),
  ]);
  assert.equal(done.verdict, "completed");
  const failed = await read([
    ...steps(2),
    ev("session.failed", { code: "Error", message: "boom", sessionId: "s" }),
  ]);
  assert.equal(failed.verdict, "session-failed");
  assert.equal(
    turnMayBeLive(failed.turn),
    false,
    "no cancel after a failed session",
  );
});

void test("a cancel refused with no_active_turn is fine too: the stream boundary decides the outcome", async () => {
  await cancelRaced(() => Promise.resolve({ status: "no_active_turn" }));
});

// ── Поток хода для тестов: события со своими meta.id, как их отдаёт MessageResponse eve ──

function ev(type: string, data: Record<string, unknown> = {}, id?: string) {
  return {
    type,
    data,
    meta: { at: "2026-09-26T04:00:00.000Z", id: id ?? `evt_${++nextId}` },
  };
}
function started(stepIndex: number, turnId = TURN) {
  return ev("step.started", { modelId: "m", sequence: 0, stepIndex, turnId });
}
function completed(stepIndex: number, usage: unknown, turnId = TURN) {
  return ev("step.completed", {
    finishReason: "tool-calls",
    sequence: 0,
    stepIndex,
    turnId,
    usage,
  });
}
function steps(count: number, usage: unknown = { inputTokens: 1000 }) {
  return Array.from({ length: count }, (_, i) => [
    started(i),
    completed(i, usage),
  ]).flat();
}
function report(message: string, finishReason = "stop") {
  return ev("message.completed", {
    finishReason,
    message,
    sequence: 0,
    stepIndex: 0,
    turnId: TURN,
  });
}
function outcome(type: "turn.completed" | "turn.cancelled" | "turn.failed") {
  return ev(type, { sequence: 0, turnId: TURN });
}
function waiting() {
  return ev("session.waiting", { wait: "next-user-message" });
}

/** Итератор, который помнит, сколько событий у него забрали. */
function feed(events: readonly unknown[]) {
  const pulled: string[] = [];
  return {
    pulled,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        pulled.push((event as { type: string }).type);
        yield await Promise.resolve(event);
      }
    },
  };
}

/** Отмена-двойник: помнит turnId и что успели прочитать к её вызову. */
function canceller(
  result: () => Promise<unknown> = () =>
    Promise.resolve({ status: "accepted" }),
) {
  const calls: { turnId: string; pulledBefore: number }[] = [];
  let source: { pulled: string[] } | undefined;
  return {
    calls,
    watch<S extends { pulled: string[] }>(stream: S): S {
      source = stream;
      return stream;
    },
    cancel: (turnId: string) => {
      calls.push({ turnId, pulledBefore: source?.pulled.length ?? 0 });
      return result();
    },
  };
}

async function read(events: readonly unknown[], cancel = canceller()) {
  const log: string[] = [];
  const stream = cancel.watch(feed(events));
  const { turn, error } = await readNightTurn(stream, cancel.cancel, (line) =>
    log.push(line),
  );
  return {
    turn,
    error,
    log,
    calls: cancel.calls,
    pulled: stream.pulled,
    verdict: turnVerdict(turn, error),
  };
}

void test("the configured stop time is taken only when it is a sane epoch in milliseconds", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: NOW + 1, max: NOW + 2 ** 31 - 1 }),
      (stopAt) => {
        assert.equal(resolveStopAt(String(stopAt), NOW), stopAt);
      },
    ),
  );
  // Ручной запуск мимо раннера получает тот же потолок расписания от своего старта.
  assert.equal(
    resolveStopAt(undefined, NOW),
    NOW + DEFAULT_TIMEOUT_MS - JOB_STOP_GRACE_MS,
  );
  assert.equal(resolveStopAt("", NOW), resolveStopAt(undefined, NOW));
});

void test("a malformed stop time is refused instead of falling back to a default", () => {
  // Тихий дефолт снова развёл бы срок хода и потолок расписания; число за пределом
  // 32-битного таймера Node схлопнул бы в 1 мс.
  // Прошедший момент — не срок: ход кончился бы, не начавшись.
  for (const past of ["0", String(NOW)])
    assert.throws(() => resolveStopAt(past, NOW), /IVA_JOB_STOP_AT=/u);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string().filter((raw) => raw !== "" && !/^\d+$/u.test(raw)),
        fc
          .bigInt({ min: BigInt(NOW) + 2n ** 31n, max: 10n ** 30n })
          .map(String),
      ),
      (raw) => {
        assert.throws(() => resolveStopAt(raw, NOW), /IVA_JOB_STOP_AT=/u);
      },
    ),
  );
});

void test("the token ceiling cancels the turn right after the step.completed that crossed it, with the next step.started never read", async () => {
  const big = { inputTokens: NIGHT_MAX_INPUT_TOKENS / 50 };
  const run = await read([
    ...steps(50, big),
    started(50),
    outcome("turn.cancelled"),
    waiting(),
  ]);
  assert.equal(NIGHT_MAX_INPUT_TOKENS, 8_000_000);
  // 50-й step.completed — сотое событие потока: отмена ушла до чтения 101-го.
  assert.deepEqual(run.calls, [{ turnId: TURN, pulledBefore: 100 }]);
  assert.equal(run.turn.inputTokens, NIGHT_MAX_INPUT_TOKENS);
  assert.equal(run.verdict, "cut");
});

void test("a turn refused by the model (turn.failed, then session.waiting) is a failed turn without a cut, not a confirmed one", async () => {
  const run = await read([...steps(3), outcome("turn.failed"), waiting()]);
  assert.equal(run.verdict, "failed");
  assert.equal(turnMayBeLive(run.turn), false);
  assert.deepEqual(run.calls, []);
});

void test("an honest finish on exactly 120 steps is not a cut: it returns its result and requires no cancel", async () => {
  const run = await read([
    ev("turn.started", { turnId: TURN }),
    ...steps(NIGHT_MAX_STEPS),
    report("отчёт ночи"),
    outcome("turn.completed"),
    waiting(),
  ]);
  assert.equal(NIGHT_MAX_STEPS, 120);
  assert.deepEqual(run.calls, []);
  assert.equal(run.verdict, "completed");
  assert.equal(run.turn.steps, 120);
  assert.equal(run.turn.message, "отчёт ночи");
});

void test("the cleanup deadlines: the reset outlasts the 30 s the eve server waits for a live turn, and cancel plus reset fit into the runner's grace", () => {
  // waitForCommandHookRelease, COMMAND_HOOK_READY_TIMEOUT_MS = 3e4 (eve 0.51.1,
  // dist/src/execution/workflow-runtime.js): a shorter client deadline would abort every
  // reset of a live session before the server could answer.
  assert.equal(NIGHT_CANCEL_MS, 20_000);
  assert.equal(NIGHT_RESET_MS, 40_000);
  assert.ok(NIGHT_RESET_MS > 30_000);
  assert.ok(NIGHT_CANCEL_MS + NIGHT_RESET_MS <= JOB_STOP_GRACE_MS - 10_000);
});

void test("an event type off the prototype (constructor, toString) is no outcome: the turn stays live", () => {
  const { turn, observe } = nightTurnReader(() => {});
  observe(ev("turn.started", { turnId: TURN }));
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    observe(ev(type, { turnId: TURN }));
  assert.equal(turn.outcome, null);
  assert.equal(turnMayBeLive(turn), true);
});

void test("the deadline overrides are read only under IVA_NIGHT_TEST_DEADLINES=1: a service .env with the variables changes nothing", () => {
  // Константы читаются при загрузке модуля, поэтому каждый набор окружения — свой процесс.
  const constants = (env: Record<string, string>) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const m = await import("./scripts/lib/rollup-turn.ts"); console.log(JSON.stringify([m.NIGHT_CANCEL_MS, m.NIGHT_RESET_MS, m.NIGHT_MIN_TURN_MS]));',
        ],
        {
          cwd: new URL("../..", import.meta.url),
          encoding: "utf8",
          env: {
            ...process.env,
            IVA_NIGHT_CANCEL_MS: "1",
            IVA_NIGHT_RESET_MS: "2",
            IVA_NIGHT_MIN_TURN_MS: "3",
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ) as number[];
  assert.deepEqual(
    constants({ IVA_NIGHT_TEST_DEADLINES: "" }),
    [20_000, 40_000, 300_000],
  );
  assert.deepEqual(constants({ IVA_NIGHT_TEST_DEADLINES: "1" }), [1, 2, 3]);
});
