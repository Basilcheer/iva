/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Раздел «расписания» доктора на таблице фактов (T20 п.5): последний запуск имени и
// незакрытые провалы. Пульс минутного диспетчера говорит раздел напоминаний той же
// команды (scripts/cli/doctor.ts), второго источника об одном mtime нет.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { jobFactsFile, recordFact, type JobFact } from "#lib/job-facts.ts";
import { scheduleFactsReport } from "./doctor.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-night",
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR + 1000,
    ok: false,
    error: "exited 1",
    exitCode: 1,
    tail: "",
    acked: false,
    wake: null,
    ...overrides,
  };
}

test("последний запуск каждого имени: ok и провал с причиной", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t20-doctor-"));
  await recordFact(jobFactsFile(dir), fact(), NOW);
  await recordFact(
    jobFactsFile(dir),
    fact({ name: "jobs-watchdog", ok: true, error: null, exitCode: 0 }),
    NOW,
  );
  const report = await scheduleFactsReport(dir, NOW);
  assert.deepEqual(report.lastRuns, [
    "jobs-watchdog: ok, 2026-09-13T10:00:01.000Z",
    "memory-night: провал (exited 1), 2026-09-13T10:00:01.000Z",
  ]);
  assert.deepEqual(
    report.openFailures.map((entry) => entry.name),
    ["memory-night"],
  );
});

test("закрытый провал не считается открытым, имя без фактов не выводится", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t20-doctor-"));
  await recordFact(
    jobFactsFile(dir),
    fact({ ok: true, error: null, exitCode: 0 }),
    NOW,
  );
  const report = await scheduleFactsReport(dir, NOW);
  assert.deepEqual(report.openFailures, []);
  assert.equal(report.lastRuns.length, 1);
});

// Снятые расписания (memory-daily, -weekly, -monthly, -yearly ушли в ночь, digest — в Brief):
// их последний провал в jobs.json остаётся навсегда, и доктор не говорит о том, чего больше нет.
test("снятое расписание не выводится и не считается открытым провалом", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t20-doctor-"));
  for (const name of [
    "memory-daily",
    "memory-weekly",
    "memory-monthly",
    "memory-yearly",
    "digest",
  ])
    await recordFact(jobFactsFile(dir), fact({ name }), NOW);
  await recordFact(jobFactsFile(dir), fact({ name: "jobs-watchdog" }), NOW);
  const report = await scheduleFactsReport(dir, NOW);
  assert.deepEqual(report.lastRuns, [
    "jobs-watchdog: провал (exited 1), 2026-09-13T10:00:01.000Z",
  ]);
  assert.deepEqual(
    report.openFailures.map((entry) => entry.name),
    ["jobs-watchdog"],
  );
});

// iva jobs ack закрывает провал: строка остаётся, но без «: провал», по которой доктор
// предупреждает.
test("провал, закрытый iva jobs ack, не предупреждает", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t20-doctor-"));
  await recordFact(jobFactsFile(dir), fact({ acked: true }), NOW);
  const report = await scheduleFactsReport(dir, NOW);
  assert.deepEqual(report.lastRuns, [
    "memory-night: закрытый провал (exited 1), 2026-09-13T10:00:01.000Z",
  ]);
  assert.ok(!report.lastRuns[0].includes(": провал"));
  assert.deepEqual(report.openFailures, []);
});
