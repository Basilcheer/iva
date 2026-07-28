import test from "node:test";
import assert from "node:assert/strict";
import {
  continuationTokenForControl,
  requestTelegramReset,
} from "./telegram-reset.mjs";
import { handleTelegramResetRequest } from "./telegram-reset-route.mjs";

test("stored Eve token wins for groups and forum topics", () => {
  const update = {
    message: {
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: 77,
      message_id: 91,
    },
  };
  assert.equal(
    continuationTokenForControl(update, {
      continuationToken: "-1001:77:42",
    }, "777"),
    "-1001:77:42",
  );
});

test("private-chat upgrade fallback reconstructs Eve token", () => {
  const update = {
    message: {
      chat: { id: 123, type: "private" },
      message_id: 10,
    },
  };
  assert.equal(continuationTokenForControl(update, null), "123::");
});

test("group upgrade fallback requires a reply to Iva", () => {
  const base = {
    chat: { id: -1001, type: "supergroup" },
    message_thread_id: 7,
    message_id: 10,
  };
  assert.equal(continuationTokenForControl({ message: base }, null), null);
  assert.equal(
    continuationTokenForControl({
      message: {
        ...base,
        reply_to_message: {
          message_id: 55,
          from: { id: 777, is_bot: true },
        },
      },
    }, null, "777"),
    "-1001:7:55",
  );
});

test("explicit Iva reply wins over the last topic token", () => {
  const token = continuationTokenForControl({
    message: {
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: 7,
      message_id: 91,
      reply_to_message: {
        message_id: 55,
        from: { id: 777, is_bot: true },
      },
    },
  }, {
    continuationToken: "-1001:7:42",
  }, "777");
  assert.equal(token, "-1001:7:55");
});

test("reply to a different bot never selects the stored Iva conversation", () => {
  assert.equal(
    continuationTokenForControl({
      message: {
        chat: { id: -1001, type: "supergroup" },
        message_thread_id: 7,
        message_id: 91,
        reply_to_message: {
          message_id: 55,
          from: { id: 888, is_bot: true },
        },
      },
    }, { continuationToken: "-1001:7:42" }, "777"),
    null,
  );
});

test("reset client sends the exact token and accepts duplicate no-active result", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, status: "no_active_session" });
  };
  const result = await requestTelegramReset({
    url: "http://127.0.0.1/eve/v1/telegram/reset",
    secret: "secret",
    continuationToken: "-1001:7:55",
    fetchImpl,
  });
  assert.equal(result.status, "no_active_session");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].init.headers["X-Telegram-Bot-Api-Secret-Token"],
    "secret",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    continuationToken: "-1001:7:55",
  });
});

test("reset client rejects HTTP and malformed success responses", async () => {
  await assert.rejects(
    requestTelegramReset({
      url: "http://local/reset",
      secret: "secret",
      continuationToken: "1::",
      fetchImpl: async () => new Response("failed", { status: 500 }),
    }),
    /HTTP 500/,
  );
  await assert.rejects(
    requestTelegramReset({
      url: "http://local/reset",
      secret: "secret",
      continuationToken: "1::",
      fetchImpl: async () => Response.json({ ok: true, status: "surprise" }),
    }),
    /invalid response/,
  );
});

test("Telegram reset route authenticates and forwards the exact raw token", async () => {
  const calls = [];
  const reset = async (input) => {
    calls.push(input);
    return { status: "reset", previousSessionId: "session-1" };
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/eve/v1/telegram/reset", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "secret",
      },
      body: JSON.stringify({ continuationToken: "-1001:7:55" }),
    }),
    reset,
    "secret",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "reset",
    previousSessionId: "session-1",
  });
  assert.deepEqual(calls, [{
    continuationToken: "-1001:7:55",
    reason: "Telegram recovery command",
  }]);
});

test("Telegram reset route rejects bad auth and bad input before reset", async () => {
  let called = false;
  const reset = async () => {
    called = true;
    return { status: "no_active_session" };
  };
  const unauthorized = await handleTelegramResetRequest(
    new Request("http://local/reset", {
      method: "POST",
      body: JSON.stringify({ continuationToken: "1::" }),
    }),
    reset,
    "secret",
  );
  assert.equal(unauthorized.status, 401);

  const malformed = await handleTelegramResetRequest(
    new Request("http://local/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: "{}",
    }),
    reset,
    "secret",
  );
  assert.equal(malformed.status, 400);
  assert.equal(called, false);
});
