/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

type RaceResult = {
  recursiveManagedRemovals: number;
  injected: boolean;
  foreignSurvived: boolean;
  rollbackErrors: number;
  liveHasOld: boolean;
  liveHasNew: boolean;
  retainedOld: boolean;
  retainedNew: boolean;
  cleanupLog: string;
};

const ROOT = resolve(import.meta.dirname, "../..");
const HARNESS = join(
  ROOT,
  "scripts/fixtures/update-resource-owners-rm-race-harness.ts",
);

function runRace(
  t: TestContext,
  resource: ".output" | "node_modules",
  phase: "live" | "backup",
): RaceResult {
  const temp = mkdtempSync(join(tmpdir(), "iva-resource-rm-race-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, resource, phase, temp],
    { cwd: ROOT, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    result.status,
    0,
    `harness failed (${resource}/${phase})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout) as RaceResult;
}

for (const resource of [".output", "node_modules"] as const) {
  test(`${resource} rollback never enters recursive deletion after ownership proof`, (t) => {
    const result = runRace(t, resource, "live");

    assert.equal(result.recursiveManagedRemovals, 0);
    assert.equal(result.injected, false);
    assert.equal(result.foreignSurvived, false);
    assert.equal(result.rollbackErrors, 0);
    assert.equal(result.liveHasOld, true);
    assert.equal(result.retainedNew, true);
    assert.match(result.cleanupLog, /cleanup debt/u);
  });

  test(`${resource} cleanup never enters recursive deletion after ownership proof`, (t) => {
    const result = runRace(t, resource, "backup");

    assert.equal(result.recursiveManagedRemovals, 0);
    assert.equal(result.injected, false);
    assert.equal(result.foreignSurvived, false);
    assert.equal(result.liveHasNew, true);
    assert.equal(result.retainedOld, true);
    assert.match(result.cleanupLog, /cleanup debt/u);
  });
}
