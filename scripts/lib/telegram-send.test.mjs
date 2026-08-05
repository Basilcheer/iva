import assert from "node:assert/strict";
import test from "node:test";

test("telegram-send loads under bare Node and redacts outbound secrets", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => "" };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.mjs");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].chat_id, "test-chat");
  assert.equal(requests[0].text, "[REDACTED]");
});
