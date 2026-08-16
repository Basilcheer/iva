/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

type RaceResult = {
  managedRmdirs: number;
  injected: boolean;
  foreignSurvived: boolean;
  capturedOriginalSurvived: boolean;
  rollbackErrors: number;
  envBytes: string;
  outputOld: boolean;
  cleanupLog: string;
};

const ROOT = resolve(import.meta.dirname, "../..");
const HARNESS = join(
  ROOT,
  "scripts/fixtures/update-resource-owners-container-race-harness.ts",
);

function runRace(t: TestContext, mode: "environment" | "output"): RaceResult {
  const temp = mkdtempSync(join(tmpdir(), "iva-resource-container-race-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, mode, temp],
    { cwd: ROOT, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    result.status,
    0,
    `harness failed (${mode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout) as RaceResult;
}

for (const mode of ["environment", "output"] as const) {
  test(`${mode} cleanup never path-deletes an empty owned container`, (t) => {
    const result = runRace(t, mode);

    assert.equal(result.managedRmdirs, 0);
    assert.equal(result.injected, false);
    assert.equal(result.foreignSurvived, false);
    assert.equal(result.capturedOriginalSurvived, false);
    assert.equal(result.rollbackErrors, 0);
    assert.equal(result.envBytes, "original-env\n");
    if (mode === "output") assert.equal(result.outputOld, true);
    assert.match(result.cleanupLog, /cleanup debt/u);
  });
}
