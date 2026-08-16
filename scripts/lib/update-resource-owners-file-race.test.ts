/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

type RaceResult = {
  managedUnlinks: number;
  injected: boolean;
  foreignSurvived: boolean;
  capturedOriginalSurvived: boolean;
  rollbackErrors: number;
  liveBytes: string;
  retainedBackup: boolean;
  cleanupLog: string;
};

const ROOT = resolve(import.meta.dirname, "../..");
const HARNESS = join(
  ROOT,
  "scripts/fixtures/update-resource-owners-file-race-harness.ts",
);

function runRace(t: TestContext, phase: "live" | "backup"): RaceResult {
  const temp = mkdtempSync(join(tmpdir(), "iva-resource-file-race-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, phase, temp],
    { cwd: ROOT, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    result.status,
    0,
    `harness failed (${phase})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout) as RaceResult;
}

test("environment rollback never unlinks the live file", (t) => {
  const result = runRace(t, "live");

  assert.equal(result.managedUnlinks, 0);
  assert.equal(result.injected, false);
  assert.equal(result.rollbackErrors, 0);
  assert.equal(result.liveBytes, "original\n");
});

test("environment backup cleanup never unlinks after ownership proof", (t) => {
  const result = runRace(t, "backup");

  assert.equal(result.managedUnlinks, 0);
  assert.equal(result.injected, false);
  assert.equal(result.foreignSurvived, false);
  assert.equal(result.capturedOriginalSurvived, false);
  assert.equal(result.liveBytes, "original\n");
  assert.equal(result.retainedBackup, true);
  assert.match(result.cleanupLog, /cleanup debt/u);
});
