import test from "node:test";
import assert from "node:assert/strict";

import { validateTimeZone as validateAuthored } from "#lib/timezone.ts";
import { validateTimeZone } from "./timezone.ts";

// Оба дерева экспортируют одну функцию: authored tree проверяет зону на старте сервера,
// scripts/ — когда Doctor пишет юниты без каталога agent/.
const CASES: readonly [unknown, string | null][] = [
  [" Asia/Tashkent ", "Asia/Tashkent"],
  ["Mars/Olympus", null],
  [undefined, null],
  ["", null],
  ["   ", null],
  ["UTC", "UTC"],
];

void test("authored and operational trees export one validator", () => {
  assert.equal(validateAuthored, validateTimeZone);
});

for (const [input, expected] of CASES) {
  void test(`timezone validation agrees on ${JSON.stringify(input)}`, () => {
    assert.equal(validateTimeZone(input), expected);
    assert.equal(validateAuthored(input), expected);
  });
}
