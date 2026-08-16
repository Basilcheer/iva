/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства резолвера на случайных деревьях. Якоря контракта — в custom-skills.test.ts,
// здесь генератор мешает валидные пакеты с мусором, которого на диске у пользователя
// сколько угодно: имена не из ASCII, папки без SKILL.md, пустые папки, не-md файлы.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { readCustomSkills } from "./custom-skills.ts";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-custom-skills-pbt-"));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

// Хвост имени из символов, которые eve разрешает. Голова — порядковый номер записи,
// поэтому имена в одном дереве не сталкиваются даже на регистро-независимой ФС.
const nameTail = fc
  .array(fc.constantFrom(..."abzABZ019._-"), { maxLength: 8 })
  .map((chars) => chars.join(""));

const siblingPath = fc.constantFrom(
  "references/checklist.md",
  "references/deep/notes.md",
  "scripts/run.py",
  "assets/logo.bin",
);

const KINDS = [
  "package",
  "flat",
  "junkName",
  "noSkillMd",
  "emptyDir",
  "notMd",
] as const;

type Entry = {
  tail: string;
  kind: (typeof KINDS)[number];
  siblings: string[];
};

const entry: fc.Arbitrary<Entry> = fc.record({
  tail: nameTail,
  kind: fc.constantFrom(...KINDS),
  siblings: fc.uniqueArray(siblingPath, { maxLength: 3 }),
});

const tree = fc.array(entry, { maxLength: 8 });

type Planted = { expected: string[]; markdown: Map<string, string> };

function plant(dir: string, entries: readonly Entry[]): Planted {
  const expected: string[] = [];
  const markdown = new Map<string, string>();
  entries.forEach((item, index) => {
    const name = `${index}x${item.tail}`;
    const body = `---\ndescription: skill ${index}\n---\n\nbody ${index}\n`;
    switch (item.kind) {
      case "package":
        write(dir, `${name}/SKILL.md`, body);
        for (const sibling of item.siblings)
          write(dir, `${name}/${sibling}`, `sibling ${index}\n`);
        expected.push(name);
        markdown.set(name, body);
        break;
      case "flat":
        write(dir, `${name}.md`, body);
        expected.push(name);
        markdown.set(name, body);
        break;
      case "junkName":
        // Пробел и кириллица: eve такое имя не примет, резолвер обязан отсеять сам.
        write(dir, `привет ${index}.md`, body);
        break;
      case "noSkillMd":
        write(dir, `${name}/notes.txt`, "not a skill\n");
        break;
      case "emptyDir":
        mkdirSync(join(dir, name), { recursive: true });
        break;
      case "notMd":
        write(dir, `${name}.txt`, "not a skill\n");
        break;
    }
  });
  return { expected: expected.sort(), markdown };
}

const RUNS = { numRuns: 60 };

test("property: exactly the valid skills come back, whatever else lies in the directory", async () => {
  await fc.assert(
    fc.asyncProperty(tree, async (entries) => {
      const dir = mkdtempSync(join(world(), "tree-"));
      const { expected, markdown } = plant(dir, entries);

      const skills = await readCustomSkills(dir, () => {});

      assert.deepEqual(Object.keys(skills).sort(), expected);
      for (const [name, body] of markdown)
        assert.equal(skills[name].markdown, body);
    }),
    RUNS,
  );
});

test("property: a package keeps every sibling file it has, and only those", async () => {
  await fc.assert(
    fc.asyncProperty(
      nameTail,
      fc.uniqueArray(siblingPath, { maxLength: 4 }),
      async (tail, siblings) => {
        const dir = mkdtempSync(join(world(), "pkg-"));
        const name = `0x${tail}`;
        write(dir, `${name}/SKILL.md`, "---\ndescription: d\n---\n\nbody\n");
        for (const sibling of siblings)
          write(dir, `${name}/${sibling}`, "content\n");

        const skills = await readCustomSkills(dir, () => {});
        assert.deepEqual(
          Object.keys(skills[name].files ?? {}).sort(),
          [...siblings].sort(),
        );
      },
    ),
    RUNS,
  );
});

test("property: reading the same tree twice gives the same map", async () => {
  await fc.assert(
    fc.asyncProperty(tree, async (entries) => {
      const dir = mkdtempSync(join(world(), "twice-"));
      plant(dir, entries);

      const first = await readCustomSkills(dir, () => {});
      const second = await readCustomSkills(dir, () => {});
      assert.deepEqual(first, second);
    }),
    RUNS,
  );
});
