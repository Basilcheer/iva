/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTRUCTIONS_DIR,
  nightInstructionFiles,
  nightInstructions,
  sectionName,
} from "./night-instructions.ts";

test("every night set exists and goes out under its own section headers, in order", () => {
  for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
    const text = nightInstructions(period);
    const headers = [...text.matchAll(/^### Rules: (.+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(
      headers,
      nightInstructionFiles(period).map(sectionName),
      period,
    );
  }
  // Блок уходит в каждый шаг ночи: рост дневного набора — решение, а не случайность.
  const daily = nightInstructions("daily").length;
  assert.ok(daily < 36_000, `daily rules block is ${daily} chars`);
});

test("a missing or empty rule file is a loud error that names the file", (t) => {
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
    /### Rules: weekly-reflection/u,
  );
  writeFileSync(
    join(dir, "rules", "weekly-reflection.md"),
    "---\nname: x\n---\n\n",
  );
  assert.throws(
    () => nightInstructions("weekly", dir),
    /night instructions: rules\/weekly-reflection\.md in .* is empty/u,
  );
});

test("the texts refer to each other by section, never by a path into instructions/", () => {
  for (const period of ["daily", "weekly", "monthly", "yearly"] as const)
    assert.doesNotMatch(
      nightInstructions(period),
      /scripts\/memory\/instructions/u,
    );
});
