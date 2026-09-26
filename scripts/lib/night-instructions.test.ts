/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTRUCTIONS_DIR,
  nightInstructionFiles,
  nightInstructions,
} from "./night-instructions.ts";

test("every night set exists and goes out under its own section headers, in order", () => {
  for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
    const text = nightInstructions(period);
    const headers = [...text.matchAll(/^### (.+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(
      headers.filter((name) => nightInstructionFiles(period).includes(name)),
      [...nightInstructionFiles(period)],
      period,
    );
  }
});

test("a missing rule file is a loud error that names the file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-night-rules-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(INSTRUCTIONS_DIR, dir, { recursive: true });
  rmSync(join(dir, "rules", "core-format.md"));
  assert.throws(
    () => nightInstructions("daily", dir),
    /night instructions: cannot read rules\/core-format\.md/u,
  );
  assert.match(
    nightInstructions("weekly", dir),
    /### rules\/weekly-reflection\.md/u,
  );
});

test("the texts refer to each other by section, never by a path into instructions/", () => {
  for (const period of ["daily", "weekly", "monthly", "yearly"] as const)
    assert.doesNotMatch(
      nightInstructions(period),
      /scripts\/memory\/instructions/u,
    );
});
