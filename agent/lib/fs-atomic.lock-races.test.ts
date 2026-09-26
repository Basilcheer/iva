/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Порядки событий из контрпримеров TLC к модели замка (T95) на настоящем коде.
// (а) — контракт 3 (docs/quality/tla-plan-2026-09-26.md): параллельная уборка может
// снести пустую папку живого претендента, претендент повторяет, двух держателей не
// бывает. Контрпример раунда 1 — коммит 6b8a8978 (ветка feat/t95-filelock-tla-r1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS = join(ROOT, "scripts/fixtures/lock-race-harness.ts");

function lockDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "iva-lock-races-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

// Трасса fast-3p (20 шагов): папка упавшего протухла; два уборщика увидели её пустой и
// той же; первый снёс её, живой претендент создал свою; rmdir второго снёс уже её.
test("a stale-lock cleaner may remove a contender's fresh directory: the contender retries, never two holders", (t) => {
  const run = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, lockDir(t)],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(result.victimDirRemoved, true, "the race was replayed");
  assert.equal(result.victimHeld, true, "the contender took the lock on retry");
  assert.equal(
    result.cleanerHeld,
    false,
    "two live holders of one lock at once",
  );
  assert.equal(result.owners, 1);
});
