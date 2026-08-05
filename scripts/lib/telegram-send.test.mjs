import assert from "node:assert/strict";
import test from "node:test";

test("telegram-send loads under bare Node and redacts outbound secrets", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
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
  assert.equal(
    requests[0].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[0].body.chat_id, "test-chat");
  assert.equal(requests[0].body.text, "[REDACTED]");
});

test("telegram-send keeps redaction when retrying a rejected HTML message", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    const status = requests.length === 1 ? 400 : 200;
    return {
      ok: status === 200,
      status,
      text: async () => (status === 400 ? "bad entities" : ""),
    };
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

  assert.deepEqual(result, { ok: true, fellBack: true, error: "" });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[1].body.chat_id, "test-chat");
  assert.equal(requests[1].body.text, "[REDACTED]");
  assert.equal("parse_mode" in requests[1].body, false);
});
