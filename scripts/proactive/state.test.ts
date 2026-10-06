/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Разбор data/proactive.json (readProactiveState): property-проверка на произвольном JSON и на
// почти верном состоянии с одним испорченным полем. Свойство: либо строгий отказ без правки
// файла, либо состояние полного контракта. Сид печатается в имени теста, повтор — FC_SEED=<сид>.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import {
  initialState,
  readProactiveState,
  type ProactiveState,
} from "./state.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const ROOT = mkdtempSync(join(tmpdir(), "iva-proactive-state-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const FILE = join(ROOT, "proactive.json");

const count = fc.nat({ max: 1_000 });
const dayCount = fc.record({ day: fc.string({ maxLength: 12 }), count });
/** Поле Insight (ADR-0022): необязательное, файл без него — файл прежней версии. */
const insight = fc.record(
  {
    day: fc.string({ maxLength: 12 }),
    draft: fc.string({ maxLength: 12 }),
    // Отпечаток черновика (ADR-0022, пересмотр 06.10.2026): необязателен, файл без него читается.
    tree: fc.string({ maxLength: 12 }),
  },
  { requiredKeys: ["day", "draft"] },
);
const validState: fc.Arbitrary<ProactiveState> = fc
  .tuple(
    fc.record({
      schemaVersion: fc.constant(1),
      seen: fc.dictionary(
        fc.string({ maxLength: 20 }),
        fc.record({
          firstSeenMs: fc.integer(),
          unread: count,
          reported: fc.boolean(),
        }),
        { maxKeys: 5 },
      ),
      wakes: dayCount,
      modelWakes: dayCount,
      briefDone: fc.record({
        day: fc.string({ maxLength: 12 }),
        slots: fc.array(count, { maxLength: 3 }),
      }),
      failuresSeenUpToMs: fc.integer(),
    }),
    fc.option(insight, { nil: undefined }),
  )
  .map(([state, s]) => (s === undefined ? state : { ...state, insight: s }));

/** Почти верное состояние: одно поле верхнего уровня или вложенное заменено мусором. */
const damaged = fc
  .tuple(
    validState,
    fc.constantFrom(
      "schemaVersion",
      "seen",
      "wakes",
      "modelWakes",
      "briefDone",
      "failuresSeenUpToMs",
      "wakes.count",
      "briefDone.slots",
      "insight",
      "insight.day",
      "insight.draft",
      "insight.tree",
    ),
    fc.anything(),
  )
  .map(([state, path, junk]) => {
    const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const [head, tail] = path.split(".");
    if (head === "insight" && !isObjectLike(copy.insight))
      copy.insight = { day: "", draft: "" };
    if (tail === undefined) copy[head] = junk;
    else (copy[head] as Record<string, unknown>)[tail] = junk;
    return copy;
  });

const isObjectLike = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Полный контракт состояния — проверка, независимая от isState. */
function fullContract(state: ProactiveState): void {
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  assert.equal(state.schemaVersion, 1);
  for (const entry of Object.values(state.seen)) {
    assert.ok(Number.isFinite(entry.firstSeenMs));
    assert.ok(count(entry.unread));
    assert.equal(typeof entry.reported, "boolean");
  }
  for (const c of [state.wakes, state.modelWakes]) {
    assert.equal(typeof c.day, "string");
    assert.ok(count(c.count));
  }
  assert.equal(typeof state.briefDone.day, "string");
  assert.ok(state.briefDone.slots.every(count));
  assert.ok(Number.isFinite(state.failuresSeenUpToMs));
  if (state.insight === undefined) return;
  assert.equal(typeof state.insight.day, "string");
  assert.equal(typeof state.insight.draft, "string");
  const tree: unknown = state.insight.tree;
  assert.ok(tree === undefined || typeof tree === "string");
}

function check(text: string): void {
  writeFileSync(FILE, text);
  let state: ProactiveState | null;
  try {
    state = readProactiveState(FILE);
  } catch (error) {
    // Строгий отказ: ошибка с путём, файл на месте байт в байт (без переименования).
    assert.match((error as Error).message, /proactive\.json/u);
    assert.equal(readFileSync(FILE, "utf8"), text);
    return;
  }
  assert.ok(state !== null);
  fullContract(state);
}

test(`readProactiveState on any JSON: a strict refusal or a state of the full contract (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.oneof(fc.jsonValue(), damaged, validState), (value) =>
      check(JSON.stringify(value)),
    ),
    { seed: SEED, numRuns: 1000 },
  );
});

test(`readProactiveState on any text, not only JSON: never anything but refusal or full contract (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (text) => check(text)),
    { seed: SEED, numRuns: 300 },
  );
});

test("readProactiveState anchors: no file — null; a valid state round-trips; a newer schema is refused", () => {
  rmSync(FILE, { force: true });
  assert.equal(readProactiveState(FILE), null);
  const state = initialState(Date.UTC(2026, 9, 5));
  writeFileSync(FILE, JSON.stringify(state));
  assert.deepEqual(readProactiveState(FILE), state);
  writeFileSync(FILE, JSON.stringify({ ...state, schemaVersion: 2 }));
  assert.throws(() => readProactiveState(FILE), /newer Iva/u);
});

test(`a file without insight (an older Iva) is read, and a damaged insight is refused like any other field (seed ${SEED})`, () => {
  fc.assert(
    fc.property(validState, (state) => {
      const text = JSON.stringify({ ...state, insight: undefined });
      writeFileSync(FILE, text);
      assert.deepEqual(readProactiveState(FILE), JSON.parse(text));
    }),
    { seed: SEED, numRuns: 300 },
  );
  const state = initialState(Date.UTC(2026, 9, 5));
  for (const insight of [
    "x",
    { day: 1, draft: "" },
    { day: "", draft: 5 },
    { day: "" },
  ]) {
    writeFileSync(FILE, JSON.stringify({ ...state, insight }));
    assert.throws(() => readProactiveState(FILE), /proactive state form/u);
  }
});

test(`a file of the version with the weekly pause is read: misses and pausedUntilMs of any value mean nothing (seed ${SEED})`, () => {
  const state = initialState(Date.UTC(2026, 9, 5));
  fc.assert(
    fc.property(
      fc.string({ maxLength: 12 }),
      fc.string({ maxLength: 12 }),
      fc.anything(),
      fc.anything(),
      (day, draft, misses, pausedUntilMs) => {
        const insight = { day, draft, misses, pausedUntilMs };
        writeFileSync(FILE, JSON.stringify({ ...state, insight }));
        const read = readProactiveState(FILE);
        assert.equal(read?.insight?.day, day);
        assert.equal(read?.insight?.draft, draft);
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

test("a file of the first beta with a spark field is read, and the field is not taken for insight", () => {
  const state = initialState(Date.UTC(2026, 9, 5));
  for (const spark of [
    { day: "2026-10-05", draft: "a", misses: 1, pausedUntilMs: 9e15 },
    "x",
  ]) {
    writeFileSync(FILE, JSON.stringify({ ...state, spark }));
    const read = readProactiveState(FILE);
    assert.ok(read !== null);
    assert.equal(read.insight, undefined);
  }
});

test("insight.tree: absent (an older file) or a string is read; anything else refuses the file like any field", () => {
  const state = initialState(Date.UTC(2026, 9, 5));
  const base = { day: "2026-10-05", draft: "x-y" };
  for (const insight of [base, { ...base, tree: "0123456789ab" }]) {
    writeFileSync(FILE, JSON.stringify({ ...state, insight }));
    assert.deepEqual(readProactiveState(FILE)?.insight, insight);
  }
  for (const tree of [5, null, ["a"], { a: 1 }, true]) {
    writeFileSync(
      FILE,
      JSON.stringify({ ...state, insight: { ...base, tree } }),
    );
    assert.throws(() => readProactiveState(FILE), /proactive state form/u);
  }
});

test(`Watch and Brief writes carry insight.tree byte for byte on any sequence of their runs (seed ${SEED})`, async () => {
  const { PROACTIVE_DEFAULTS } = await import("#lib/proactive-config.ts");
  const { runProactiveTick } = await import("./tick.ts");
  const { writeProactiveState } = await import("./state.ts");
  const MIN = 60_000;
  const START = Date.UTC(2026, 9, 5, 8, 0);
  const insight = {
    day: "2026-10-05",
    draft: "x-y",
    tree: "0123456789ab",
  };
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          step: fc.integer({ min: 1, max: 6 }).map((n) => n * 30 * MIN),
          unread: fc.nat({ max: 3 }),
          reply: fc.constantFrom("QUIET", "Иван ждёт ответа.", ""),
          ok: fc.boolean(),
        }),
        { maxLength: 8 },
      ),
      async (runs) => {
        const path = join(mkdtempSync(join(ROOT, "carry-")), "proactive.json");
        await writeProactiveState(path, { ...initialState(START), insight });
        let now = START;
        for (const run of runs) {
          now += run.step;
          await runProactiveTick(now, {
            config: () => ({
              ...PROACTIVE_DEFAULTS,
              briefTimes: ["09:00", "14:00"],
              staleMinutes: 0,
            }),
            timeZone: "UTC",
            statePath: path,
            sources: [
              {
                name: "telegram",
                prefix: "tg:",
                check: () =>
                  Promise.resolve({
                    items:
                      run.unread > 0
                        ? [{ key: "tg:1", unread: run.unread, from: {} }]
                        : [],
                    error: null,
                  }),
              },
            ],
            runTurn: () =>
              Promise.resolve({
                status: "completed",
                message: run.reply,
                feedback: () => Promise.resolve(),
              }),
            send: () => Promise.resolve({ ok: run.ok, error: "x" }),
            translate: () => Promise.resolve((en: string) => en),
            log: () => {},
          });
          assert.equal(
            JSON.stringify(readProactiveState(path)?.insight),
            JSON.stringify(insight),
          );
        }
      },
    ),
    { seed: SEED, numRuns: 60 },
  );
});
