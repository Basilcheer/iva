/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Имя хода `<session>/<turn>` и его разбор: туда и обратно без потерь, мусор не бросает.
import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { parseTurnRef, turnRef } from "./turn-ref.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const noSlash = fc.string({ minLength: 1 }).filter((s) => !s.includes("/"));
// Сессия может содержать `/`: ход отделяет последний.
const session = fc.string({ minLength: 1 });

test(`PBT: parseTurnRef(turnRef(s, t)) возвращает s и t (seed ${SEED})`, () => {
  fc.assert(
    fc.property(session, noSlash, (s, t) => {
      assert.deepEqual(parseTurnRef(turnRef(s, t)), { session: s, turn: t });
    }),
    { seed: SEED },
  );
});

test(`PBT: parseTurnRef на любой строке не бросает (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string(), (ref) => {
      const parsed = parseTurnRef(ref);
      if (parsed !== null)
        assert.equal(`${parsed.session}/${parsed.turn}`, ref);
    }),
    { seed: SEED },
  );
});

test("parseTurnRef: не пара — null", () => {
  assert.equal(parseTurnRef("a/"), null);
  assert.equal(parseTurnRef("/b"), null);
  assert.equal(parseTurnRef("ab"), null);
});

test("turnRef: без сессии или хода — то, что есть", () => {
  assert.equal(turnRef("wrun_1", "turn_0"), "wrun_1/turn_0");
  assert.equal(turnRef("", "turn_3"), "turn_3");
  assert.equal(turnRef("wrun_1", ""), "wrun_1");
  assert.equal(turnRef("", ""), "");
});
