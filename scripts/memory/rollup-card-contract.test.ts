import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(HERE, path), "utf8");

function assertBefore(text: string, first: string, second: string): void {
  const firstAt = text.indexOf(first);
  const secondAt = text.indexOf(second);
  assert.ok(firstAt >= 0, `missing contract fragment: ${first}`);
  assert.ok(secondAt >= 0, `missing contract fragment: ${second}`);
  assert.ok(firstAt < secondAt, `${first} must precede ${second}`);
}

void test("daily rollup prompt exposes the same four card operations as dbrain", () => {
  const rollup = read("rollup.ts");
  for (const fragment of [
    "ADD (new)",
    "UPDATE (existing subject, compatible new fact)",
    "SUPERSEDE (contradicts a current value)",
    "NOOP (already known)",
    "Pass history_entry only for SUPERSEDE",
    "write_card owns the '## History' section",
  ]) {
    assert.match(rollup, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const processInstructions = read("instructions/dbrain-processor/phases/process.md");
  for (const operation of ["ADD", "UPDATE", "SUPERSEDE", "NOOP"]) {
    assert.match(processInstructions, new RegExp(`\\*\\*${operation}\\*\\*`));
  }
  assert.match(
    processInstructions,
    /Never pass `history_entry` with ADD, UPDATE, or NOOP\./,
  );
});

void test("every nightly mechanical path runs bounded cleanup before whole-file enforce", () => {
  const skill = read("instructions/dbrain-processor/SKILL.md");
  const summarize = read("instructions/dbrain-processor/phases/summarize.md");
  const doctor = read("doctor.ts");
  for (const text of [skill, summarize, doctor]) {
    assertBefore(text, "cleanup.py", "enforce.py");
  }
});
