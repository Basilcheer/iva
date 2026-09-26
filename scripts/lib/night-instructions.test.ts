/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTRUCTIONS_DIR,
  nightInstructionFiles,
  nightInstructions,
} from "./night-instructions.ts";

const PERIODS = ["daily", "weekly", "monthly", "yearly"] as const;
// Файлы правил, которые сознательно не идут ни в одну ночь. Новый файл без записи здесь
// обязан попасть в набор: иначе ночь его молча не увидит.
const NOT_IN_ANY_NIGHT: readonly string[] = [];

test("every night set is the instruction tree minus an explicit exclusion list, each file under its own section", () => {
  const tree = readdirSync(INSTRUCTIONS_DIR, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".md"))
    .sort();
  const sets = PERIODS.flatMap((period) => nightInstructionFiles(period));
  assert.deepEqual([...new Set([...sets, ...NOT_IN_ANY_NIGHT])].sort(), tree);
  for (const period of PERIODS)
    assert.equal(
      nightInstructions(period).split(/^### Rules: /mu).length - 1,
      nightInstructionFiles(period).length,
      period,
    );
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

test("the texts carry no frontmatter: a section never opens with --- and no paths: line goes out", () => {
  for (const period of PERIODS) {
    const text = nightInstructions(period);
    assert.doesNotMatch(text, /^### Rules: .+\n\n---$/mu, period);
    assert.doesNotMatch(text, /^paths:/mu, period);
  }
});

// Граница процесса: отказ набора — одна строка на stderr и код 1, без стека.
test("the loader boundary exits 1 with one line: missing file, empty file, frontmatter only", (t) => {
  const cases: [string, string | null][] = [
    ["missing", null],
    ["empty", ""],
    ["frontmatter", '---\npaths: "monthly/**/*.md"\n---\n'],
  ];
  for (const [label, content] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "iva-night-exit-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(INSTRUCTIONS_DIR, dir, { recursive: true });
    const file = join(dir, "rules", "monthly-format.md");
    if (content === null) rmSync(file);
    else writeFileSync(file, content);
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(join(import.meta.dirname, "night-instructions.ts"))});` +
          `m.nightInstructionsOrExit("monthly", () => m.nightInstructions("monthly", ${JSON.stringify(dir)})); console.log("loaded");`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1, `${label}: ${run.stderr}`);
    assert.equal(run.stdout, "", label);
    assert.match(
      run.stderr,
      /^rollup monthly: night instructions: [^\n]*rules\/monthly-format\.md[^\n]*\n$/u,
      label,
    );
  }
});
