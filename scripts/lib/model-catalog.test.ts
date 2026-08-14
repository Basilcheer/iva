import { test } from "node:test";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import {
  CATALOG,
  FALLBACK_EFFORTS,
  ModelCatalogError,
  fetchModelOptions,
} from "./model-catalog.ts";

// Каталог — вторая половина шва: по нему строятся кнопки /model, мастер и `iva doctor`
// (они грузятся на инсталле, где agent/ может не быть, ADR-0003), а принимает значение
// authored-резолвер. Разъедься перечни — мастер предложил бы провайдера, на котором
// рантайм откажется стартовать, или доктор объявил бы .env здоровым перед отказом.
// Порядок тоже общий: он же задаёт порядок имён в сообщении об отказе.
test("both trees accept exactly the same provider names, in the same order", () => {
  assert.deepEqual(Object.keys(CATALOG), [...MODEL_PROVIDER_NAMES]);
});

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
