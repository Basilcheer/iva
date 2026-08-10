import test from "node:test";
import assert from "node:assert/strict";

import { CANONICAL_REASONING_EFFORTS as AUTHORED } from "#lib/reasoning-levels.ts";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "./reasoning-levels.ts";

// Кнопки /think строит эта половина, а принимает усилие agent/provider.ts из своей копии.
// Разъедься они — мастер предложил бы уровень, который рантайм молча выбросит.
void test("both trees offer the same canonical reasoning vocabulary", () => {
  assert.deepEqual([...CANONICAL_REASONING_EFFORTS], [...AUTHORED]);
});

void test("the conservative fallback stays a subset of the vocabulary", () => {
  for (const effort of FALLBACK_REASONING_EFFORTS)
    assert.ok(AUTHORED.includes(effort), effort);
});
