import assert from "node:assert/strict";
import { test } from "node:test";

import { openrouterErrReason } from "./openrouter.ts";

void test("OpenRouter error reasons unwrap provider metadata without losing fallbacks", () => {
  assert.equal(openrouterErrReason({}, 429), "HTTP 429");
  assert.equal(
    openrouterErrReason({ error: { message: "Provider returned error" } }, 502),
    "Provider returned error",
  );
  assert.equal(
    openrouterErrReason(
      {
        error: {
          message: "Provider returned error",
          metadata: {
            provider_name: "xAI",
            raw: '{"error":{"message":"not available in your region"}}',
          },
        },
      },
      400,
    ),
    "not available in your region (xAI)",
  );
  assert.equal(
    openrouterErrReason(
      {
        error: {
          metadata: { raw: { error: "upstream rejected request" } },
        },
      },
      400,
    ),
    "upstream rejected request",
  );
  assert.equal(
    openrouterErrReason({ error: { metadata: { raw: "not JSON" } } }, 400),
    "not JSON",
  );
});

void test("OpenRouter error reasons retain legacy malformed-shape behavior", () => {
  // The former JavaScript function returned a truthy non-string `message`
  // unchanged; its declared TS return type must not introduce coercion.
  assert.equal(openrouterErrReason({ error: { message: 17 } }, 400), 17);
  assert.equal(
    openrouterErrReason(
      { error: { message: "Provider returned error", metadata: { raw: [] } } },
      400,
    ),
    "Provider returned error",
  );
  assert.equal(
    openrouterErrReason(
      {
        error: {
          message: "Provider returned error",
          metadata: { raw: { error: [] } },
        },
      },
      400,
    ),
    "Provider returned error",
  );
  const raw = () => "provider function";
  assert.equal(
    openrouterErrReason({ error: { metadata: { raw } } }, 400),
    String(raw),
  );
});
