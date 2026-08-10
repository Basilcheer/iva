import test from "node:test";
import assert from "node:assert/strict";

import { validateTimeZone as validateAuthored } from "#lib/timezone.ts";
import { validateTimeZone } from "./timezone.ts";

// Обе копии предиката гоняются по ОДНОЙ таблице: authored tree проверяет зону на старте
// сервера, scripts/ — когда `iva doctor` пишет юниты без каталога agent/. Разъехаться
// молча они не могут: расхождение падает здесь.
const CASES: readonly [unknown, string | null][] = [
  [" Asia/Tashkent ", "Asia/Tashkent"],
  ["Mars/Olympus", null],
  [undefined, null],
  ["", null],
  ["   ", null],
  ["UTC", "UTC"],
];

for (const [input, expected] of CASES) {
  void test(`timezone validation agrees on ${JSON.stringify(input)}`, () => {
    assert.equal(validateTimeZone(input), expected);
    assert.equal(validateAuthored(input), expected);
  });
}
