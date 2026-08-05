import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listCodexModelCatalog,
  parseCodexModelCatalog,
} from "./codex-oauth.mjs";

test("catalog parser supports model/slug/id/name and preserves quoted Unicode IDs", () => {
  const parsed = parseCodexModelCatalog({
    result: {
      items: [
        {
          model: "gpt-5.5",
          supported_reasoning_levels: [
            "minimal",
            { effort: "low" },
            { level: "MAX" },
            "ultra",
          ],
        },
        {
          slug: 'gpt-"кавычка"',
          supported_reasoning_levels: [{ id: "medium" }],
        },
        { id: "preset-id", supported_reasoning_levels: [{ name: "high" }] },
        { name: "модель-имя", supported_reasoning_levels: [] },
      ],
    },
    tiers: [{ id: "not-a-model" }],
  });

  const byId = Object.fromEntries(
    parsed.map((entry) => [entry.id, entry.reasoningLevels]),
  );
  assert.deepEqual(byId["gpt-5.5"], ["minimal", "low", "max"]);
  assert.deepEqual(byId['gpt-"кавычка"'], ["medium"]);
  assert.deepEqual(byId["preset-id"], ["high"]);
  assert.deepEqual(byId["модель-имя"], ["low", "medium", "high"]);
  assert.equal(byId["not-a-model"], undefined);
});

test("catalog parser handles strings, nested wrappers, empty and malformed input", () => {
  assert.deepEqual(parseCodexModelCatalog(null), []);
  assert.deepEqual(
    parseCodexModelCatalog({ models: [null, {}, "", "   ", { model: 42 }] }),
    [],
  );
  assert.deepEqual(parseCodexModelCatalog(["gpt-5", "модель"]), [
    { id: "gpt-5", reasoningLevels: ["low", "medium", "high"] },
    { id: "модель", reasoningLevels: ["low", "medium", "high"] },
  ]);
  assert.deepEqual(
    parseCodexModelCatalog({
      envelope: {
        data: [{ model: "gpt-6", supported_reasoning_levels: "bad" }],
      },
    }),
    [{ id: "gpt-6", reasoningLevels: ["low", "medium", "high"] }],
  );
});

test("model catalog and reasoning levels come from one HTTP request", async () => {
  let requests = 0;
  const result = await listCodexModelCatalog({
    dataDir: "/unused",
    authHeadersFn: async () => ({ Authorization: "Bearer test" }),
    fetchFn: async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          models: [
            { model: "gpt-5.5", supported_reasoning_levels: ["low", "high"] },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(result, [
    { id: "gpt-5.5", reasoningLevels: ["low", "high"] },
  ]);
});
