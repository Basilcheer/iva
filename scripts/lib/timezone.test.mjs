import test from "node:test";
import assert from "node:assert/strict";

import { validateTimeZone } from "./timezone.mjs";

test("timezone validation accepts a real IANA zone", () => {
  assert.equal(validateTimeZone(" Asia/Tashkent "), "Asia/Tashkent");
});

test("timezone validation rejects a syntactically plausible unknown zone", () => {
  assert.equal(validateTimeZone("Mars/Olympus"), null);
});

test("timezone validation rejects an undefined value", () => {
  assert.equal(validateTimeZone(undefined), null);
});
