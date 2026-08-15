/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { resolveMemorySearchMode } from "./memory-mode.ts";

// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает в отчёте строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь их вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
const RUNS = { numRuns: 500 };
const WHITESPACE = ["", " ", "\t", "\n", "\r\n", "\u00a0"] as const;

const embeddingSource = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(...WHITESPACE),
  fc.constantFrom(
    "jina_test-key",
    "deepinfra-real-key",
    "https://embeddings.example.test/v1",
  ),
  fc
    .string({ minLength: 1, maxLength: 40, unit: "grapheme" })
    .filter((value) => value.trim().length > 0),
);

const embeddingEnv = fc.record({
  JINA_API_KEY: embeddingSource,
  DEEPINFRA_API_KEY: embeddingSource,
  MEMORY_EMBED_URL: embeddingSource,
});

test("empty jina input without another embedding source keeps BM25", () => {
  assert.equal(resolveMemorySearchMode(true, { JINA_API_KEY: "" }), "grep");
});

test("an existing deepinfra key keeps hybrid after empty jina input", () => {
  assert.equal(
    resolveMemorySearchMode(true, {
      JINA_API_KEY: "",
      DEEPINFRA_API_KEY: "some-real-key",
    }),
    "hybrid",
  );
});

test("property: hybrid is selected exactly when requested with an embedding source", () => {
  fc.assert(
    fc.property(fc.boolean(), embeddingEnv, (wantsHybrid, env) => {
      const hasEmbeddingSource = [
        env.JINA_API_KEY,
        env.DEEPINFRA_API_KEY,
        env.MEMORY_EMBED_URL,
      ].some((value) => Boolean(value?.trim()));

      assert.equal(
        resolveMemorySearchMode(wantsHybrid, env),
        wantsHybrid && hasEmbeddingSource ? "hybrid" : "grep",
      );
    }),
    RUNS,
  );
});
