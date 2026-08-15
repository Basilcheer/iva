import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  parseUpdateCallbackData,
  validRecoveryBundleId,
} from "./update-callback.ts";

const SEED = 18_702;

void test("update callback parser accepts only exact actions", () => {
  assert.deepEqual(parseUpdateCallbackData("iva_update:do"), { action: "do" });
  assert.deepEqual(parseUpdateCallbackData("iva_update:skip"), {
    action: "skip",
  });
  assert.deepEqual(parseUpdateCallbackData("iva_update:conflicts:bundle-1.2"), {
    action: "conflicts",
    bundleId: "bundle-1.2",
  });
  for (const invalid of [
    "",
    "iva_update:",
    "iva_update:run",
    "iva_update:do-now",
    "iva_update:skip ",
    "iva_update:conflicts:",
    "iva_update:conflicts:.",
    "iva_update:conflicts:..",
    "iva_update:conflicts:/tmp/x",
    null,
    1,
    {},
  ]) {
    assert.equal(
      parseUpdateCallbackData(invalid),
      null,
      JSON.stringify(invalid) ?? typeof invalid,
    );
  }
});

void test("property: accepted callback data has one canonical representation", () => {
  fc.assert(
    fc.property(fc.anything(), (data) => {
      const parsed = parseUpdateCallbackData(data);
      if (parsed === null) return;
      assert.equal(typeof data, "string");
      if (parsed.action === "do" || parsed.action === "skip") {
        assert.equal(data, `iva_update:${parsed.action}`);
        return;
      }
      assert.equal(data, `iva_update:conflicts:${parsed.bundleId}`);
      assert.equal(validRecoveryBundleId(parsed.bundleId), true);
    }),
    { seed: SEED, numRuns: 2_000 },
  );
});

void test("property: every generated valid conflict suffix round-trips", () => {
  const alphaNumeric = fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  );
  const tail = fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-",
  );
  fc.assert(
    fc.property(
      fc.tuple(alphaNumeric, fc.array(tail, { maxLength: 63 })),
      ([first, rest]) => {
        const bundleId = `${first}${rest.join("")}`;
        assert.deepEqual(
          parseUpdateCallbackData(`iva_update:conflicts:${bundleId}`),
          { action: "conflicts", bundleId },
        );
      },
    ),
    { seed: SEED, numRuns: 1_000 },
  );
});
