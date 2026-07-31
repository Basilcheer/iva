import test from "node:test";
import assert from "node:assert/strict";
import {
  continuationTokenForControl,
  requestTelegramReset,
} from "./telegram-reset.mjs";
import { toChannelLocalToken } from "./telegram-continuation-token.mjs";
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

test("namespaced stored token is normalized before reset (#110)", () => {
  // Реальная запись с прода: обработчики событий eve отдают токен с именем канала
  // впереди, и он попадал в data/run-status.d как есть. Reset-роут клеил "telegram:"
  // второй раз → no_active_session, мост печатал «контекст очищен» вхолостую.
  const privateUpdate = { message: { chat: { id: 7091451031, type: "private" }, message_id: 5 } };
  assert.equal(
    continuationTokenForControl(privateUpdate, { continuationToken: "telegram:7091451031::" }, "777"),
    "7091451031::",
  );

  const groupUpdate = {
    message: { chat: { id: -1001, type: "supergroup" }, message_thread_id: 77, message_id: 91 },
  };
  assert.equal(
    continuationTokenForControl(groupUpdate, { continuationToken: "telegram:-1001:77:42" }, "777"),
    "-1001:77:42",
  );

  const callbackOnly = { callback_query: { id: "cb" } };
  assert.equal(
    continuationTokenForControl(callbackOnly, { continuationToken: "telegram:7091451031::" }, "777"),
    "7091451031::",
  );
});

test("normalization strips the channel prefix and nothing else", () => {
  // Срезается ровно известное имя канала. Числовую проверку первого сегмента делать
  // нельзя: у групп chatId отрицательный, и форма токена — контракт eve, не наша догадка.
  assert.equal(toChannelLocalToken("telegram:7091451031::"), "7091451031::");
  assert.equal(toChannelLocalToken("telegram:-1001:77:42"), "-1001:77:42");

  // Уже локальные токены не трогаем — в том числе групповые с минусом.
  assert.equal(toChannelLocalToken("7091451031::"), "7091451031::");
  assert.equal(toChannelLocalToken("-1001:77:42"), "-1001:77:42");
  assert.equal(toChannelLocalToken("123::"), "123::");
  assert.equal(toChannelLocalToken(""), "");

  // Срезается ровно ОДИН префикс. Двойной "telegram:telegram:…" в персисте невозможен —
  // eve неймспейсит токен ровно один раз, а довфиксные значения одинарные, — но именно
  // такую строку собирал reset-роут из нашего токена, и она обязана схлопываться в один
  // проход, а не превращаться в "telegram:…" от повторной нормализации.
  const warnings = [];
  assert.equal(
    toChannelLocalToken("telegram:telegram:7091451031::", { warn: (m) => warnings.push(m) }),
    "telegram:7091451031::",
  );
  assert.equal(warnings.length, 1, "нераспознанная форма обязана попасть в журнал");
});

test("an unexpected token shape is reported instead of silently passed on", () => {
  // Не throw: поведение не меняем, но следующая смена формы токена станет громкой
  // строкой в journalctl, а не тихим повторением #110.
  const warnings = [];
  const warn = (message) => warnings.push(message);

  assert.equal(toChannelLocalToken("slack:C123:456", { warn }), "slack:C123:456");
  assert.equal(toChannelLocalToken("telegram:not-a-chat-id", { warn }), "not-a-chat-id");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /unexpected shape: "slack:C123:456"/);
  assert.match(warnings[1], /unexpected shape: "telegram:not-a-chat-id"/);

  // Нормальные токены молчат, включая групповые с минусом и пустое значение.
  const quiet = [];
  for (const token of ["7091451031::", "-1001:77:42", "telegram:-1001:77:42", "123", ""]) {
    toChannelLocalToken(token, { warn: (m) => quiet.push(m) });
  }
  assert.deepEqual(quiet, []);
});
