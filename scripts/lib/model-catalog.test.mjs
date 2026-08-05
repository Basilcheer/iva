import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_EFFORTS,
  ModelCatalogError,
  fetchModelOptions,
} from "./model-catalog.mjs";

test("Codex catalog failure cannot create selectable fallback models", async () => {
  await assert.rejects(
    fetchModelOptions("codex", undefined, {
      listCodexCatalog: async () => {
        throw new Error("offline");
      },
    }),
    (error) =>
      error instanceof ModelCatalogError &&
      error.code === "catalog_unavailable",
  );
});

test("Ollama Cloud and OpenCode Go expose their OpenAI-compatible reasoning contract", async () => {
  for (const provider of ["ollama", "opencode"]) {
    const options = await fetchModelOptions(provider, "test", {
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "reasoning-model" }],
          }),
          { status: 200 },
        ),
    });
    assert.deepEqual(options, [
      {
        id: "reasoning-model",
        reasoningLevels: [...FALLBACK_EFFORTS],
      },
    ]);
  }
});

test("heterogeneous OpenRouter catalog does not invent reasoning choices", async () => {
  const options = await fetchModelOptions("openrouter", "unused");
  assert.ok(options.length > 0);
  assert.ok(options.every((option) => option.reasoningLevels.length === 0));
});
