// Golden-фикстуры двуязычных парсер-пар (TECH_DEBT §13). Те же файлы читает
// scripts/autograph/tests/test_autograph.py — оба раннера сверяются с ОДНИМ
// ожиданием, поэтому диалекты TS/Python не могут разъехаться молча:
//   (a) frontmatter — agent/lib/frontmatter.ts ↔ scripts/autograph/common.py;
//   (b) fence-aware сканер секций — agent/lib/card-store.ts ↔ scripts/autograph/enforce.py.
// Формы результатов у сторон разные (TS — объект, Python — кортеж), поэтому
// сравнивается только нормализованный словарь: fields+body для (a),
// outside[] + [start,end) секций по заголовку для (b).

import "./lib/ts-esm-hooks.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const { parseFrontmatter } = await import("../agent/lib/frontmatter.ts");
const { h2Sections, outsideFences } = await import("../agent/lib/card-store.ts");

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "autograph/tests/golden");

function cases(sub) {
  const dir = join(GOLDEN, sub);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f.replace(/\.md$/, ""),
      input: readFileSync(join(dir, f), "utf8"),
      expected: JSON.parse(readFileSync(join(dir, f.replace(/\.md$/, ".json")), "utf8")),
    }));
}

const frontmatterCases = cases("frontmatter");
test("golden: каталог frontmatter не пуст", () => {
  assert.ok(frontmatterCases.length >= 7);
});
for (const { name, input, expected } of frontmatterCases) {
  test(`golden frontmatter: ${name}`, () => {
    const parsed = parseFrontmatter(input);
    assert.deepEqual(parsed.fields, expected.fields);
    assert.equal(parsed.body, expected.body);
  });
}

const sectionCases = cases("sections");
test("golden: каталог sections не пуст", () => {
  assert.ok(sectionCases.length >= 7);
});
for (const { name, input, expected } of sectionCases) {
  test(`golden sections: ${name}`, () => {
    const lines = input.split("\n");
    assert.deepEqual(outsideFences(lines), expected.outside);
    for (const [heading, ranges] of Object.entries(expected.sections)) {
      assert.deepEqual(
        h2Sections(lines, heading).map((s) => [s.start, s.end]),
        ranges,
        `heading ${heading}`,
      );
    }
  });
}
