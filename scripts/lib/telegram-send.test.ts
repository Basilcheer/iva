import assert from "node:assert/strict";
import test from "node:test";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

function parseRequestBody(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Expected a JSON object request body");
  return Object.fromEntries(Object.entries(parsed));
}

function captureRequest(
  url: URL | RequestInfo,
  options?: RequestInit,
): CapturedRequest {
  const body = options?.body;
  if (typeof body !== "string")
    throw new TypeError("Expected a JSON request body");
  const requestUrl =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return { url: requestUrl, body: parseRequestBody(body) };
}

void test("telegram-send loads under bare Node and redacts outbound secrets", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
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

void test("telegram-send keeps redaction when retrying a rejected HTML message", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    const status = requests.length === 1 ? 400 : 200;
    return Promise.resolve(
      new Response(status === 400 ? "bad entities" : "", { status }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
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

void test("telegram-send stops at a status Telegram cannot retry as plain", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("too many requests", { status: 429 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    Array.from({ length: 400 }, (_, i) => `line ${i} of the report`).join(
      "\n\n",
    ),
  );

  assert.deepEqual(result, {
    ok: false,
    fellBack: false,
    error: "429: too many requests",
  });
  assert.equal(requests.length, 1);
});

void test("telegram-send never throws on a report that is not a string", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml("test-bot", "test-chat", { report: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.fellBack, false);
  assert.ok(result.error.length > 0);
  assert.deepEqual(requests, []);
});
