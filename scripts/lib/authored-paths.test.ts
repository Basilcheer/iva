/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// isLivePath — одно правило «читается с диска на ходу, не вход сборки» для checkout и
// версии. Генератор собирает путь из слота, вложенности и расширения, ответ известен по
// построению. Провал печатает seed; воспроизвести: fc.assert(prop, { seed, path }).
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { isLivePath } from "./authored-paths.ts";

const SEED = Number(process.env.FC_SEED ?? 20_261_006);

const SLOTS = [
  "agent/skills",
  "agent/instructions",
  "agent/tools",
  "agent/connections",
  "agent/subagents",
  "agent",
  "scripts",
  "agent/skillsx",
] as const;

const segment = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,11}$/u);

const pathArb = fc.record({
  slot: fc.constantFrom(...SLOTS),
  dirs: fc.array(segment, { maxLength: 3 }),
  name: segment,
  ext: fc.constantFrom(".md", ".ts", ".json", ""),
});

test(`isLivePath holds for skills and markdown rules only (seed ${SEED})`, () => {
  fc.assert(
    fc.property(pathArb, ({ slot, dirs, name, ext }) => {
      const path = [slot, ...dirs, `${name}${ext}`].join("/");
      const expected =
        slot === "agent/skills" ||
        (slot === "agent/instructions" && ext === ".md");
      assert.equal(isLivePath(path), expected, path);
    }),
    { seed: SEED, numRuns: 500 },
  );
});

test("isLivePath anchors", () => {
  for (const path of [
    "agent/skills/zz-crooked/SKILL.md",
    "agent/skills/flat.md",
    "agent/skills/pack/scripts/run.sh",
    "agent/instructions/rules.md",
  ])
    assert.equal(isLivePath(path), true, path);
  for (const path of [
    "agent/instructions/30-mine.ts",
    "agent/instructions.md",
    "agent/connections/mine.ts",
    "agent/tools/notes.md",
    "agent/skills",
  ])
    assert.equal(isLivePath(path), false, path);
});
