import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsage, subagentTurnId } from "#lib/usage.ts";
import {
  formatUsageReport,
  parseWindow,
  readEntries,
  summarize,
  type UsageRecord,
} from "./usage.ts";

const step = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  ts: "2026-07-31T01:23:14.343Z",
  source: "channel:telegram",
  provider: "ollama",
  model: "deepseek-v4-pro",
  sessionId: "wrun_1",
  turnId: "turn_1",
  step: 0,
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  ...over,
});

void test("last turn reports the current context, not the sum of steps", () => {
  const entries = [
    step({ step: 0, in: 104_632, out: 160, total: 104_792 }),
    step({ step: 1, in: 105_537, out: 755, total: 106_292 }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 105_537);
  assert.equal(last.out, 915);
  assert.equal(last.steps, 2);
  assert.equal(last.total, 211_084);
});

void test("last turn ignores steps of earlier turns and other sessions", () => {
  const entries = [
    step({
      sessionId: "wrun_0",
      turnId: "turn_9",
      in: 999_999,
      out: 1,
      total: 1_000_000,
    }),
    step({ turnId: "turn_0", in: 500, out: 5, total: 505 }),
    step({ step: 0, in: 21_448, out: 160, total: 21_608 }),
    step({ step: 1, in: 25_103, out: 755, total: 25_858 }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 25_103);
  assert.equal(last.out, 915);
  assert.equal(last.steps, 2);
  assert.equal(last.model, "deepseek-v4-pro");
});

void test("single-step turn keeps its own input", () => {
  const { last } = summarize([step({ in: 21_448, out: 160, total: 21_608 })], {
    window: "last",
  });
  assert.ok(last);
  assert.equal(last.in, 21_448);
  assert.equal(last.out, 160);
});

void test("empty log has no last turn", () => {
  assert.deepEqual(summarize([], { window: "last" }), {
    window: "last",
    last: null,
  });
  assert.equal(
    formatUsageReport({ window: "last", last: null }),
    "No usage logged yet.",
  );
});

void test("last-turn report labels the input as context", () => {
  const agg = summarize(
    [
      step({ step: 0, in: 104_632, out: 160, total: 104_792 }),
      step({ step: 1, in: 105_537, out: 755, cacheRead: 12, total: 106_292 }),
    ],
    { window: "last" },
  );
  assert.deepEqual(formatUsageReport(agg).split("\n"), [
    "Last turn: 211 084 tokens",
    "context 105 537 · out 915 · cached 12",
    "2 steps · deepseek-v4-pro · chat",
  ]);
});

void test("windowed summaries still sum inputs across turns", () => {
  const agg = summarize(
    [
      step({ turnId: "turn_0", in: 100, out: 10, total: 110 }),
      step({ turnId: "turn_1", in: 200, out: 20, total: 220 }),
    ],
    { window: "today", now: Date.parse("2026-07-31T12:00:00Z"), tz: "UTC" },
  );
  assert.equal(agg.totals.in, 300);
  assert.equal(agg.totals.turns, 2);
});

void test("parseWindow falls back to the last turn", () => {
  assert.equal(parseWindow(), "last");
  assert.equal(parseWindow("by model"), "by-model");
  assert.equal(parseWindow("нечто"), "last");
});

void test("legacy TypeScript callers retain mutable records and dynamic windows", () => {
  const record = step();
  record.in = 42;
  const window: string = "today";
  const aggregate = summarize([record], {
    window,
    now: Date.parse("2026-07-31T12:00:00Z"),
    tz: "UTC",
  });

  assert.match(formatUsageReport(aggregate), /^Today: 0 tokens/);
});

void test("legacy malformed records still label a missing source as other", () => {
  assert.match(
    formatUsageReport({
      window: "last",
      last: {
        in: 0,
        out: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        steps: 1,
        turns: 1,
        model: "model",
        source: undefined,
        subagent: null,
        when: "2026-07-31T01:23:14.343Z",
        contextFromSubagent: false,
      },
    }),
    /1 step · model · other$/,
  );
});

void test("a subagent step never masquerades as the main session's context", () => {
  const entries = [
    step({ turnId: "turn_5", step: 0, in: 104_632, out: 160, total: 104_792 }),
    step({ turnId: "turn_5", step: 1, in: 105_537, out: 300, total: 105_837 }),
    step({
      turnId: "turn_5#planner",
      subagent: "planner",
      step: 0,
      in: 19_800,
      out: 90,
      total: 19_890,
    }),
    step({
      turnId: "turn_5#planner",
      subagent: "planner",
      step: 1,
      in: 20_100,
      out: 120,
      total: 20_220,
    }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 105_537);
  assert.equal(last.contextFromSubagent, false);
  assert.equal(last.subagent, "planner");
  assert.equal(last.out, 670);
  assert.equal(last.steps, 4);
  assert.equal(last.total, 250_739);
});

void test("an old turn with the same number can never be picked up (#110 review)", () => {
  const entries = [
    step({
      ts: "2026-07-24T10:00:00.000Z",
      turnId: "turn_0",
      in: 5_000,
      out: 50,
      total: 5_050,
    }),
    step({ turnId: "turn_5", step: 0, in: 105_537, out: 300, total: 105_837 }),
    step({
      turnId: "turn_5#planner",
      subagent: "planner",
      step: 0,
      in: 19_800,
      out: 90,
      total: 19_890,
    }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 105_537);
  assert.equal(last.contextFromSubagent, false);
  assert.equal(last.steps, 2, "давний одноимённый ход в текущий не входит");
});

void test("main-session step after a subagent still wins the context", () => {
  const entries = [
    step({
      turnId: "turn_5#planner",
      subagent: "planner",
      in: 19_800,
      out: 90,
      total: 19_890,
    }),
    step({ turnId: "turn_5", in: 105_537, out: 300, total: 105_837 }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 105_537);
});

void test("a turn made only of subagent steps is reported as approximate", () => {
  const agg = summarize(
    [
      step({
        turnId: "turn_5#planner",
        subagent: "planner",
        in: 19_800,
        out: 90,
        total: 19_890,
      }),
    ],
    { window: "last" },
  );
  assert.ok(agg.last);
  assert.equal(agg.last.in, 19_800);
  assert.equal(agg.last.contextFromSubagent, true);
  assert.match(formatUsageReport(agg), /context ~19 800 \(subagent step\)/);
});

void test("legacy records without the turn suffix are still filtered by the subagent field", () => {
  const entries = [
    step({ turnId: "turn_0", in: 105_537, out: 300, total: 105_837 }),
    step({
      turnId: "turn_0",
      subagent: "planner",
      in: 19_800,
      out: 90,
      total: 19_890,
    }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 105_537);
});

void test("a subagent step is not counted as a separate turn in windowed summaries", () => {
  const agg = summarize(
    [
      step({ turnId: "turn_5", in: 105_537, out: 300, total: 105_837 }),
      step({
        turnId: "turn_5#planner",
        subagent: "planner",
        in: 19_800,
        out: 90,
        total: 19_890,
      }),
    ],
    { window: "today", now: Date.parse("2026-07-31T12:00:00Z"), tz: "UTC" },
  );
  assert.equal(agg.totals.turns, 1);
  assert.equal(agg.totals.steps, 2);
});

// Пишет лог authored tree, читает его отчёт — общего кода у половин нет, поэтому путь
// файла и форма записи держатся только на этом прогоне: разъедутся — падает здесь.
void test("the authored tree's append lands where the report reads it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-usage-roundtrip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const entries = [
    step({ step: 0, in: 104_632, out: 160, total: 104_792 }),
    step({
      step: 1,
      turnId: subagentTurnId({ id: "turn_1", sequence: 1 }, "planner"),
      subagent: "planner",
      in: 19_800,
      out: 90,
      total: 19_890,
    }),
  ];
  for (const entry of entries) appendUsage(entry, dataDir);

  assert.deepEqual(readEntries(dataDir), entries);
  const { last } = summarize(readEntries(dataDir), { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 104_632);
  assert.equal(last.subagent, "planner");
  assert.equal(last.steps, 2);
});

void test("a fallback key still groups into the parent turn and keeps context clean", () => {
  const entries = [
    step({ turnId: "turn_7", in: 105_537, out: 300, total: 105_837 }),
    step({
      turnId: subagentTurnId({ id: "", sequence: 7 }, "planner", "turn_0"),
      subagent: "planner",
      in: 19_800,
      out: 90,
      total: 19_890,
    }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.ok(last);
  assert.equal(last.in, 105_537);
  assert.equal(last.steps, 2);
  assert.equal(last.contextFromSubagent, false);
});
