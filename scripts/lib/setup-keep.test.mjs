import assert from "node:assert/strict";
import { test } from "node:test";

import { keptSetupWritePlan } from "./setup-keep.mjs";

test("keeping byte-equivalent setup skips the full model-config rewrite", () => {
  const existing = {
    AGENT_LANGUAGE: "en",
    MODEL_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "secret",
    OPENROUTER_MODEL: "retired/model",
  };

  assert.equal(keptSetupWritePlan(existing, { ...existing }), "skip");
  assert.equal(
    keptSetupWritePlan(existing, { ...existing, AGENT_LANGUAGE: "ru" }),
    "validate-and-write",
  );
});
