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
/** Поле Spark (ADR-0022): необязательное, файл без него — файл прежней версии. */
const spark = fc.record({
  day: fc.string({ maxLength: 12 }),
  draft: fc.string({ maxLength: 12 }),
  misses: count,
  pausedUntilMs: fc.integer(),
});
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
    fc.option(spark, { nil: undefined }),
  )
  .map(([state, s]) => (s === undefined ? state : { ...state, spark: s }));

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
      "spark",
      "spark.day",
      "spark.misses",
      "spark.pausedUntilMs",
    ),
    fc.anything(),
  )
  .map(([state, path, junk]) => {
    const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const [head, tail] = path.split(".");
    if (head === "spark" && !isObjectLike(copy.spark))
      copy.spark = { day: "", draft: "", misses: 0, pausedUntilMs: 0 };
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
  if (state.spark === undefined) return;
  assert.equal(typeof state.spark.day, "string");
  assert.equal(typeof state.spark.draft, "string");
  assert.ok(count(state.spark.misses));
  assert.ok(Number.isFinite(state.spark.pausedUntilMs));
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

test(`a file without spark (an older Iva) is read, and a damaged spark is refused like any other field (seed ${SEED})`, () => {
  fc.assert(
    fc.property(validState, (state) => {
      const text = JSON.stringify({ ...state, spark: undefined });
      writeFileSync(FILE, text);
      assert.deepEqual(readProactiveState(FILE), JSON.parse(text));
    }),
    { seed: SEED, numRuns: 300 },
  );
  const state = initialState(Date.UTC(2026, 9, 5));
  for (const spark of [
    "x",
    { day: 1, draft: "", misses: 0, pausedUntilMs: 0 },
    { day: "", draft: "", misses: -1, pausedUntilMs: 0 },
    { day: "", draft: "", misses: 0 },
  ]) {
    writeFileSync(FILE, JSON.stringify({ ...state, spark }));
    assert.throws(() => readProactiveState(FILE), /proactive state form/u);
  }
});
