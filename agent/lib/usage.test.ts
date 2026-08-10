import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsage, subagentTurnId, usageFilePath } from "./usage.ts";

const record = (over: Partial<Parameters<typeof appendUsage>[0]> = {}) => ({
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

void test("the log path follows ASSISTANT_DATA_DIR", () => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = "/tmp/iva-data";
  try {
    assert.equal(usageFilePath(), "/tmp/iva-data/usage.jsonl");
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
  assert.equal(usageFilePath("data"), "data/usage.jsonl");
});

// Каталог данных на свежей установке ещё не создан: первая же запись хода не имеет права
// упасть ENOENT, а шаги одного хода должны лечь отдельными строками, а не склеиться.
void test("appending creates the data directory and keeps one record per line", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-usage-append-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");

  appendUsage(record({ step: 0 }), dataDir);
  appendUsage(record({ step: 1, subagent: "planner" }), dataDir);

  const lines = readFileSync(usageFilePath(dataDir), "utf8").split("\n");
  assert.equal(lines.length, 3); // две записи и завершающий перевод строки
  assert.equal(lines[2], "");
  assert.deepEqual(JSON.parse(lines[0]), record({ step: 0 }));
  assert.deepEqual(
    JSON.parse(lines[1]),
    record({ step: 1, subagent: "planner" }),
  );
});

void test("the subagent turn key falls back the way Eve itself does", () => {
  assert.equal(
    subagentTurnId({ id: "turn_5", sequence: 5 }, "planner", "turn_0"),
    "turn_5#planner",
  );
  assert.equal(
    subagentTurnId({ id: "", sequence: 7 }, "planner", "turn_0"),
    "turn_7#planner",
  );
  assert.equal(
    subagentTurnId({ sequence: 0 }, "planner", "turn_3"),
    "turn_0#planner",
  );
  assert.equal(
    subagentTurnId(undefined, "planner", "turn_3"),
    "turn_3#planner",
  );
  assert.equal(subagentTurnId({}, "planner", "turn_3"), "turn_3#planner");
  assert.equal(
    subagentTurnId({ id: "turn_5" }, undefined, "turn_0"),
    "turn_5#subagent",
  );
});
