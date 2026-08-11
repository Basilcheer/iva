import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
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

/** Quoted spans carrying a real date: instructions and the prompt may show a history
 * entry only in the shape write_card stores, otherwise the model writes a second date. */
function datedExamples(text: string, span = /`([^`\n]+)`/g): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  return [...prose.matchAll(span)]
    .map((match) => match[1])
    .filter(
      (candidate) => /\d{4}-\d{2}/.test(candidate) && candidate.includes(":"),
    );
}

/** Prompt quoting: 'like this'. The lookarounds skip the apostrophes prose spends on
 * "card's" and "today's", which would otherwise pair up and shift every span. */
const QUOTED = /(?<![A-Za-z0-9])'([^'\n]+?)'(?![A-Za-z0-9])/g;

/** The daily prompt as the model receives it: adjacent template chunks joined, so an
 * example split across source lines reads as the one span the model will see. */
function promptText(source: string): string {
  return source.replace(/`\s*\+\s*`/g, "");
}

void test("daily rollup prompt exposes the same four card operations as the memory-processor", () => {
  const prompt = promptText(read("rollup.ts"));
  for (const fragment of [
    "ADD (new)",
    "UPDATE (existing subject, compatible new fact)",
    "SUPERSEDE (contradicts a current value)",
    "NOOP (already known)",
    "Pass history_entry only for SUPERSEDE",
    "the fact's own date, not today's",
    "write_card owns the '## History' section",
  ]) {
    assert.match(
      prompt,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  // The SUPERSEDE rule is where the prompt shows a history entry; every dated example
  // there must read the way write_card stores the line, bullet and section excluded.
  assertBefore(
    prompt,
    "Pass history_entry only for SUPERSEDE",
    "write_card owns the '## History' section",
  );
  const supersedeRule = prompt.slice(
    prompt.indexOf("Pass history_entry only for SUPERSEDE"),
    prompt.indexOf("write_card owns the '## History' section"),
  );
  const examples = datedExamples(supersedeRule, QUOTED);
  assert.ok(
    examples.length > 0,
    "the SUPERSEDE rule must show a dated history_entry example",
  );
  for (const example of examples) {
    assert.match(
      example,
      /^\d{4}-\d{2}-\d{2}: \S/,
      `rollup.ts shows "${example}" where a history entry must read YYYY-MM-DD: fact`,
    );
  }

  const processInstructions = read(
    "instructions/memory-processor/phases/process.md",
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

void test("memory-processor phase and its reference teach one history_entry contract", () => {
  for (const name of [
    "phases/process.md",
    "references/classification.md",
    "references/card-templates.md",
  ]) {
    const text = read(`instructions/memory-processor/${name}`);
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

/** The memory-processor instructions send the model to the autograph references for canonical
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

/** Headings shown inside a fenced card example. Cards go through `write_card`, which
 * refuses an ADD or UPDATE body carrying H1/H2, so such an example teaches a call the
 * tool rejects and the fact is lost. Summaries are written as plain files, not through
 * the tool, so their own headings stay legal. */
function cardExampleHeadings(text: string): string[] {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => {
      const type = /^type: *(\S+)/m.exec(block)?.[1];
      return type !== undefined && !type.endsWith("summary");
    })
    .flatMap((block) => block.split("\n"))
    .filter((line) => /^ {0,3}#{1,2}\s+/.test(line));
}

void test("memory-processor card examples and the daily prompt keep a card body free of H1/H2", () => {
  const root = "instructions/memory-processor";
  const pages = readdirSync(join(HERE, root), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".md"));
  assert.ok(pages.length > 0, `${root} must hold the instruction pages`);
  for (const page of pages) {
    for (const heading of cardExampleHeadings(read(join(root, page)))) {
      assert.fail(
        `${root}/${page} shows "${heading}" in a card example, a body write_card refuses`,
      );
    }
  }

  for (const page of [
    "phases/process.md",
    "references/classification.md",
    "references/card-templates.md",
  ]) {
    assert.match(
      read(`${root}/${page}`),
      /no H1\/H2 headings/,
      `${page} must teach a card body without H1/H2`,
    );
  }
  assert.match(
    promptText(read("rollup.ts")),
    /no H1\/H2 headings/,
    "the daily prompt must teach a card body without H1/H2",
  );
});

void test("every nightly mechanical path runs bounded cleanup before whole-file enforce", () => {
  const skill = read("instructions/memory-processor/SKILL.md");
  const summarize = read("instructions/memory-processor/phases/summarize.md");
  const brain = read("brain.ts");
  for (const text of [skill, summarize, brain]) {
    assertBefore(text, "cleanup.py", "enforce.py");
  }
});
