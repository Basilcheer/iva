/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  CONTEXT_WINDOW_CONFIGURATION_ERROR,
  ContextWindowConfigurationError,
  resolveContextWindow,
} from "./context-window.ts";

const VARIABLE = "OLLAMA_CONTEXT_WINDOW";
const FALLBACK = 131_072;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function exactPositiveSafeInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const exact = BigInt(raw);
  if (exact <= 0n || exact > MAX_SAFE_INTEGER) return null;
  return Number(exact);
}

test("context window accepts positive safe integers and the configured fallback", () => {
  assert.equal(resolveContextWindow(VARIABLE, undefined, FALLBACK), FALLBACK);
  assert.equal(resolveContextWindow(VARIABLE, "1", FALLBACK), 1);
  assert.equal(
    resolveContextWindow(VARIABLE, String(Number.MAX_SAFE_INTEGER), FALLBACK),
    Number.MAX_SAFE_INTEGER,
  );
});

test("context window rejects every invalid numeric boundary with one typed error", () => {
  for (const raw of [
    "NaN",
    "0",
    "-7",
    "1.5",
    "1.0000000000000001",
    "9007199254740990.5",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.throws(
      () => resolveContextWindow(VARIABLE, raw, FALLBACK),
      (error: unknown) => {
        assert.ok(error instanceof ContextWindowConfigurationError);
        assert.equal(error.code, CONTEXT_WINDOW_CONFIGURATION_ERROR);
        assert.equal(error.variable, VARIABLE);
        assert.equal(error.value, raw);
        assert.equal(
          error.message,
          `Invalid ${VARIABLE} ${JSON.stringify(raw)}; expected a positive safe integer — run: iva config`,
        );
        return true;
      },
      raw,
    );
  }
});

test("property: arbitrary strings resolve to a positive safe integer or the typed error", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary" }), (raw) => {
      const exact = exactPositiveSafeInteger(raw);
      if (exact !== null) {
        assert.equal(resolveContextWindow(VARIABLE, raw, FALLBACK), exact);
        return;
      }

      assert.throws(
        () => resolveContextWindow(VARIABLE, raw, FALLBACK),
        (error: unknown) =>
          error instanceof ContextWindowConfigurationError &&
          error.code === CONTEXT_WINDOW_CONFIGURATION_ERROR,
      );
    }),
    { seed: 18802, numRuns: 1_000 },
  );
});
