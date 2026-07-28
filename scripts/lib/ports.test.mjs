import assert from "node:assert/strict";
import test from "node:test";
import { confirmOccupiedCurrentPort } from "./ports.mjs";

test("an occupied current port is never assumed to belong to Iva", async () => {
  const prompts = [];
  assert.equal(
    await confirmOccupiedCurrentPort({
      port: 8723,
      currentPort: 8723,
      confirm: async (details) => {
        prompts.push(details);
        return false;
      },
      holders: ["bind: port occupied", "docker:foreign"],
    }),
    false,
  );
  assert.deepEqual(prompts, [{
    port: 8723,
    holders: ["bind: port occupied", "docker:foreign"],
  }]);
});
test("the current occupied port is reused only after explicit confirmation", async () => {
  assert.equal(
    await confirmOccupiedCurrentPort({
      port: 8723,
      currentPort: 8723,
      confirm: async () => true,
    }),
    true,
  );
  assert.equal(
    await confirmOccupiedCurrentPort({
      port: 9000,
      currentPort: 8723,
      confirm: async () => {
        throw new Error("must not ask for a different port");
      },
    }),
    false,
  );
});
