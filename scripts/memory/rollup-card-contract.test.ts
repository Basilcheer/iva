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

/** Inline code spans carrying a real date: instructions may show a history entry
 * only in the shape write_card stores, otherwise the model writes a second date. */
function datedExamples(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  return [...prose.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1])
    .filter((span) => /\d{4}-\d{2}/.test(span) && span.includes(":"));
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
    assert.match(
      rollup,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  const processInstructions = read(
    "instructions/dbrain-processor/phases/process.md",
  );
  for (const operation of ["ADD", "UPDATE", "SUPERSEDE", "NOOP"]) {
    assert.match(processInstructions, new RegExp(`\\*\\*${operation}\\*\\*`));
  }
  assert.match(
    processInstructions,
    /Never pass `history_entry` with ADD, UPDATE, or NOOP\./,
  );
});

/** Bullets shown as History examples: inline code spans and lines that open with a
 * list marker and then a date, plus anything still using the retired `·` separator. */
function historyBullets(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  const lines = text.split("\n").map((line) => line.trim());
  return [...spans, ...lines].filter(
    (candidate) => /^- \d/.test(candidate) || candidate.includes(" · "),
  );
}

void test("dbrain phase and its reference teach one history_entry contract", () => {
  for (const name of [
    "phases/process.md",
    "references/classification.md",
    "references/card-templates.md",
  ]) {
    const text = read(`instructions/dbrain-processor/${name}`);
    assert.match(
      text,
      /`write_card` owns the `## History` section/,
      `${name} must leave the ## History section to write_card`,
    );
    assert.match(
      text,
      /Never pass `history_entry` with ADD, UPDATE, or NOOP\./,
      `${name} must keep history_entry on SUPERSEDE only`,
    );
    for (const example of datedExamples(text)) {
      assert.match(
        example,
        /^\d{4}-\d{2}-\d{2}: \S/,
        `${name} shows "${example}" where a history entry must read YYYY-MM-DD: fact`,
      );
    }
  }
});

/** The dbrain instructions send the model to the autograph references for canonical
 * card shapes, and the nightly dedup merge appends to the same section. Both must show
 * the one line format write_card stores, or the model learns to write a second one. */
void test("autograph references and the dedup merge keep one History line format", () => {
  for (const name of [
    "SKILL.md",
    "references/update-in-place.md",
    "references/card-templates.md",
    "references/schema-reference.md",
  ]) {
    const text = read(`../autograph/docs/${name}`);
    for (const bullet of historyBullets(text)) {
      assert.match(
        bullet,
        /^- \d{4}-\d{2}-\d{2}: \S/,
        `autograph ${name} shows "${bullet}" where a History line must read - YYYY-MM-DD: fact`,
      );
    }
  }

  const dedup = read("../autograph/dedup.py");
  assert.match(
    dedup,
    /return f"- \{when\}: \{field\}: \{val\}\{held\}"/,
    "dedup.py must append History lines dated the same way write_card dates them",
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
