import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import { test } from "node:test";
import {
  ModelValidationError,
  validateModelSelection,
} from "./model-validation.ts";

const response = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("catalog providers require exact live membership", async () => {
  for (const provider of ["ollama", "opencode"]) {
    const selected = await validateModelSelection(
      { provider, model: "live/model", key: "secret" },
      {
        fetchFn: async () => response({ data: [{ id: "live/model" }] }),
      },
    );
    assert.equal(selected.id, "live/model");
    await assert.rejects(
      validateModelSelection(
        { provider, model: "retired", key: "secret" },
        { fetchFn: async () => response({ data: [{ id: "live/model" }] }) },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "model_unavailable",
    );
  }

  await assert.rejects(
    validateModelSelection(
      { provider: "codex", model: "retired" },
      {
        listCodexCatalog: async () => [
          { id: "live", reasoningLevels: ["high"] },
        ],
      },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "model_unavailable",
  );
});

test("catalog outage, auth, empty and malformed responses fail closed", async () => {
  const cases = [
    {
      code: "catalog_unavailable",
      fetchFn: async () => {
        throw new Error("offline");
      },
    },
    { code: "auth_rejected", fetchFn: async () => response({}, 401) },
    { code: "auth_rejected", fetchFn: async () => response({}, 403) },
    { code: "catalog_invalid", fetchFn: async () => response({ data: [] }) },
    {
      code: "catalog_invalid",
      fetchFn: async () => response({ data: "broken" }),
    },
    {
      code: "catalog_invalid",
      fetchFn: async () => response({ data: [{ name: "missing-id" }] }),
    },
    { code: "catalog_invalid", fetchFn: async () => response("{", 200) },
  ];
  for (const item of cases) {
    await assert.rejects(
      validateModelSelection(
        { provider: "ollama", model: "live", key: "secret" },
        { fetchFn: item.fetchFn },
      ),
      (error) =>
        error instanceof ModelValidationError && error.code === item.code,
    );
  }
  await assert.rejects(
    validateModelSelection(
      { provider: "codex", model: "live" },
      { listCodexCatalog: async () => [] },
    ),
    (error) =>
      error instanceof ModelValidationError && error.code === "catalog_invalid",
  );
});

test("OpenRouter validation sends a minimal tool-call request", async () => {
  let request:
    { url: string | URL | Request; body: Record<string, unknown> } | undefined;
  const result = await validateModelSelection(
    { provider: "openrouter", model: "vendor/model", key: "secret" },
    {
      fetchFn: async (url, init) => {
        const requestUrl =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        const requestBody = typeof init?.body === "string" ? init.body : "";
        request = {
          url: requestUrl,
          body: JSON.parse(requestBody) as Record<string, unknown>,
        };
        return response({
          choices: [{ message: { tool_calls: [{ id: "1" }] } }],
        });
      },
    },
  );
  assert.equal(result.id, "vendor/model");
  assert.ok(request);
  assert.match(
    typeof request.url === "string"
      ? request.url
      : request.url instanceof URL
        ? request.url.href
        : request.url.url,
    /chat\/completions$/,
  );
  assert.equal(request.body.model, "vendor/model");
  assert.equal(
    (request.body.tools as { function: { name: string } }[])[0].function.name,
    "ping",
  );
  assert.equal(request.body.max_tokens, 32);

  const exhausted = await validateModelSelection(
    { provider: "openrouter", model: "vendor/reasoning", key: "secret" },
    {
      fetchFn: async () =>
        response({
          choices: [
            {
              finish_reason: "length",
              message: { content: "", reasoning: "hidden budget exhausted" },
            },
          ],
        }),
    },
  );
  assert.equal(exhausted.id, "vendor/reasoning");

  await assert.rejects(
    validateModelSelection(
      { provider: "openrouter", model: "vendor/no-tools", key: "secret" },
      {
        fetchFn: async () =>
          response({ error: { message: "No tool use" } }, 400),
      },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "model_unavailable",
  );
});

test("OpenRouter classifies non-JSON auth failures before parsing the body", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      validateModelSelection(
        { provider: "openrouter", model: "vendor/model", key: "bad" },
        {
          fetchFn: async () =>
            new Response("unauthorized", {
              status,
              headers: { "content-type": "text/plain" },
            }),
        },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "auth_rejected" &&
        error.status === status,
    );
  }
});

test("empty and malformed selections are rejected before provider I/O", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return response({ data: [{ id: "x" }] });
  };
  for (const model of ["", " \n ", null]) {
    await assert.rejects(
      validateModelSelection(
        { provider: "ollama", model, key: "secret" },
        { fetchFn },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "invalid_selection",
    );
  }
  await assert.rejects(
    validateModelSelection(
      { provider: "__proto__", model: "x", key: "secret" },
      { fetchFn },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "invalid_selection",
  );
  assert.equal(calls, 0);
});
