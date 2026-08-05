import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const errorModule = await import(
  pathToFileURL(
    join(
      process.cwd(),
      "node_modules/eve/dist/src/harness/model-call-error.js",
    ),
  ).href
);

test("deterministic AI SDK prompt and tool errors terminate the Eve session", () => {
  for (const name of [
    "AI_InvalidPromptError",
    "AI_NoSuchToolError",
    "AI_InvalidToolInputError",
  ]) {
    const error = Object.assign(new Error("deterministic request error"), {
      name,
    });
    assert.equal(errorModule.classifyModelCallError(error), "terminal", name);
  }
});

test("deterministic classification follows nested causes", () => {
  const cause = Object.assign(new Error("unknown tool"), {
    name: "AI_NoSuchToolError",
  });
  assert.equal(
    errorModule.classifyModelCallError(
      new Error("model call failed", { cause }),
    ),
    "terminal",
  );
});
