import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramChannel, type TelegramHandle } from "eve/channels/telegram";
import {
  flushSettledTelegramQuestions,
  postTelegramQuestion,
  settleTelegramQuestions,
  type QuestionState,
} from "./telegram-question.ts";

void test("authoritative resolution removes buttons; edit failure never loses accepted answer", async () => {
  const calls: Array<{ method: string; body: unknown }> = [];
  let fail = false;
  const tg = {
    chatId: "7",
    post(body: unknown) {
      calls.push({ method: "sendMessage", body });
      return Promise.resolve({ id: "9", raw: { text: "Confirm?" } });
    },
    request(method: string, body: unknown) {
      calls.push({ method, body });
      return Promise.resolve({
        ok: !fail,
        status: 200,
        body: { ok: !fail, result: { message_id: 9 } },
      });
    },
  } as Pick<TelegramHandle, "chatId" | "request" | "post">;
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  await postTelegramQuestion(
    {
      requestId: "q",
      action: {
        callId: "c",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      kind: "question",
      prompt: "Confirm?",
      options: [{ id: "yes", label: "Yes" }],
    },
    state,
    tg,
  );
  assert.ok(state.questionPreviews?.q);
  fail = true;
  await settleTelegramQuestions(
    [{ requestId: "q", outcome: "answered", response: { optionId: "yes" } }],
    state,
    tg,
  );
  assert.ok(state.questionPreviews?.q);
  fail = false;
  const resumed = JSON.parse(JSON.stringify(state)) as QuestionState;
  await flushSettledTelegramQuestions(resumed, tg);
  assert.equal(resumed.questionPreviews?.q, undefined);
  await flushSettledTelegramQuestions(state, tg);
  assert.equal(state.questionPreviews?.q, undefined);
  const last = calls.at(-1)!.body as {
    text: string;
    reply_markup: { inline_keyboard: unknown[] };
  };
  assert.match(last.text, /Yes/u);
  assert.deepEqual(last.reply_markup.inline_keyboard, []);
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
});

void test("Eve compiles the input.resolved public handler into its adapter", () => {
  const callback = () => {};
  const channel = telegramChannel({ events: { "input.resolved": callback } });
  // Introspection in the contract test, not a runtime monkey patch.
  assert.equal(
    typeof Reflect.get(Reflect.get(channel, "adapter"), "input.resolved"),
    "function",
  );
});

void test("rich resolution edits embedded buttons and never echoes a freeform answer", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: 42,
  };
  const tg = {
    chatId: "7",
    messageThreadId: 42,
    post: () => {
      throw new Error("unexpected native fallback");
    },
    request(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 9 } },
      });
    },
  } as unknown as TelegramHandle;
  await postTelegramQuestion(
    {
      requestId: "q-rich",
      kind: "question",
      prompt: "Accept <literal>?",
      action: {
        callId: "c",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      options: [{ id: "yes", label: "Yes" }],
      allowFreeform: true,
    },
    state,
    tg,
    true,
  );
  assert.equal(calls[0].method, "sendRichMessage");
  assert.equal(calls[0].body.message_thread_id, 42);
  assert.match(
    (calls[0].body.rich_message as { markdown: string }).markdown,
    /tg-button/u,
  );
  assert.ok(Object.keys(state.hitlCallbacks ?? {}).length);
  assert.equal(state.pendingFreeformReplies?.["9"], "q-rich");
  await settleTelegramQuestions(
    [
      {
        requestId: "q-rich",
        outcome: "answered",
        response: { text: "private-freeform-value" },
      },
    ],
    state,
    tg,
  );
  assert.equal(calls[1].method, "editMessageText");
  assert.equal(calls[1].body.message_id, 9);
  assert.doesNotMatch(
    JSON.stringify(calls[1].body),
    /tg-button|private-freeform-value/u,
  );
  assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [] });
  assert.deepEqual(state.hitlCallbacks, {});
  assert.deepEqual(state.pendingFreeformReplies, {});
  assert.deepEqual(state.questionPreviews, {});
});

void test("native ForceReply and Eve's literal long-question rendering are preserved", async () => {
  const calls: Record<string, unknown>[] = [];
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  const tg = {
    chatId: "7",
    post: (body: Record<string, unknown>) => {
      calls.push(body);
      return Promise.resolve({ id: "19", raw: {} });
    },
    request: () =>
      Promise.resolve({ ok: true, status: 200, body: { ok: true } }),
  } as unknown as TelegramHandle;
  const request = {
    requestId: "freeform",
    kind: "question" as const,
    prompt: "<literal> *not bold* " + "x".repeat(7000),
    action: {
      callId: "c",
      input: {},
      kind: "tool-call" as const,
      toolName: "ask_question",
    },
  };
  const { renderTelegramInputRequest } = await import("eve/channels/telegram");
  const expected = renderTelegramInputRequest(request, { ...state });
  await postTelegramQuestion(request, state, tg, true);
  assert.equal(calls[0].text, expected.text);
  assert.deepEqual(calls[0].reply_markup, expected.replyMarkup);
  assert.equal(state.pendingFreeformReplies?.["19"], "freeform");
  await settleTelegramQuestions(
    [
      {
        requestId: "freeform",
        outcome: "answered",
        response: { text: "secret-do-not-echo" },
      },
    ],
    state,
    tg,
  );
  assert.deepEqual(state.pendingFreeformReplies, {});
});

void test("rich send failure falls back once; failed rich edits never fall back to HTML or repost", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  let fail = true;
  const tg = {
    chatId: "7",
    post: () => {
      calls.push("sendMessage");
      return Promise.resolve({ id: "29", raw: {} });
    },
    request: (method: string) => {
      calls.push(method);
      return Promise.resolve({
        ok: !fail,
        status: fail ? 400 : 200,
        body: { ok: !fail, result: { message_id: 29 } },
      });
    },
  } as unknown as TelegramHandle;
  const request = {
    requestId: "fallback",
    kind: "question" as const,
    prompt: "Confirm?",
    action: {
      callId: "c",
      input: {},
      kind: "tool-call" as const,
      toolName: "ask_question",
    },
    options: [{ id: "yes", label: "Yes" }],
  };
  await postTelegramQuestion(request, state, tg, true);
  assert.equal(state.questionPreviews?.fallback.rich, false);
  assert.deepEqual(calls, ["sendRichMessage", "sendMessage"]);
  fail = false;
  await postTelegramQuestion(
    { ...request, requestId: "rich" },
    state,
    tg,
    true,
  );
  const before = calls.length;
  fail = true;
  await settleTelegramQuestions(
    [{ requestId: "rich", outcome: "answered", response: { optionId: "yes" } }],
    state,
    tg,
  );
  await flushSettledTelegramQuestions(
    JSON.parse(JSON.stringify(state)) as QuestionState,
    tg,
  );
  assert.deepEqual(calls.slice(before), ["editMessageText", "editMessageText"]);
  assert.ok(state.questionPreviews?.rich.settledStatus);
});

void test("Telegram unchanged result completes delivery; HTTP 200 with ok:false stays pending", async (t) => {
  t.mock.method(console, "error", () => {});
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  let unchanged = false;
  const tg = {
    chatId: "7",
    post: () => Promise.resolve({ id: "39", raw: {} }),
    request: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          ok: false,
          description: unchanged
            ? "Bad Request: message is not modified"
            : "Bad Request: cannot edit",
        },
      }),
  } as unknown as TelegramHandle;
  await postTelegramQuestion(
    {
      requestId: "q",
      kind: "question",
      prompt: "Confirm?",
      action: {
        callId: "c",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      options: [{ id: "no", label: "Cancel" }],
    },
    state,
    tg,
  );
  await settleTelegramQuestions(
    [{ requestId: "q", outcome: "denied", response: { optionId: "no" } }],
    state,
    tg,
  );
  assert.ok(state.questionPreviews?.q.settledStatus);
  unchanged = true;
  await flushSettledTelegramQuestions(state, tg);
  assert.deepEqual(state.questionPreviews, {});
});

void test("unresolved and unknown questions are never edited by recovery", async () => {
  let edits = 0;
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  const tg = {
    chatId: "7",
    post: () => Promise.resolve({ id: "9", raw: {} }),
    request: () => {
      edits++;
      return Promise.resolve({ ok: true, status: 200, body: { ok: true } });
    },
  } as unknown as TelegramHandle;
  await postTelegramQuestion(
    {
      requestId: "q",
      kind: "question",
      prompt: "Confirm?",
      action: {
        callId: "c",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      options: [{ id: "yes", label: "Yes" }],
    },
    state,
    tg,
  );
  await flushSettledTelegramQuestions(state, tg);
  await settleTelegramQuestions(
    [
      { requestId: "missing", outcome: "ignored" },
      { requestId: "__proto__", outcome: "invalid" },
    ],
    state,
    tg,
  );
  assert.equal(edits, 0);
  assert.ok(state.questionPreviews?.q);
});

void test("ambiguous rich posting failure never posts a duplicate native question", async () => {
  let posts = 0;
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  const tg = {
    chatId: "7",
    post: () => {
      posts++;
      return Promise.resolve({ id: "9", raw: {} });
    },
    request: () => Promise.reject(new Error("connection lost after send")),
  } as unknown as TelegramHandle;
  await assert.rejects(
    postTelegramQuestion(
      {
        requestId: "q",
        kind: "question",
        prompt: "Confirm?",
        action: {
          callId: "c",
          input: {},
          kind: "tool-call",
          toolName: "ask_question",
        },
        options: [{ id: "yes", label: "Yes" }],
      },
      state,
      tg,
      true,
    ),
  );
  assert.equal(posts, 0);
  assert.equal(state.questionPreviews, undefined);
});

void test("invalid or ignored resolution closes the question without claiming the rejected option was accepted", async () => {
  const edited: string[] = [];
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  const tg = {
    chatId: "7",
    post: () => Promise.resolve({ id: "9", raw: {} }),
    request: (_method: string, body: { text?: string }) => {
      edited.push(body.text ?? "");
      return Promise.resolve({ ok: true, status: 200, body: { ok: true } });
    },
  } as unknown as TelegramHandle;
  for (const outcome of ["invalid", "ignored"] as const) {
    await postTelegramQuestion(
      {
        requestId: outcome,
        kind: "question",
        prompt: "Confirm?",
        action: {
          callId: "c",
          input: {},
          kind: "tool-call",
          toolName: "ask_question",
        },
        options: [{ id: "yes", label: "Yes" }],
      },
      state,
      tg,
    );
    await settleTelegramQuestions(
      [{ requestId: outcome, outcome, response: { optionId: "yes" } }],
      state,
      tg,
    );
    assert.match(edited.at(-1)!, /Question closed|Вопрос закрыт/u);
    assert.doesNotMatch(edited.at(-1)!, /Selected|Выбрано/u);
  }
});

void test("deleted or permanently noneditable previews retire recovery metadata without another request", async () => {
  for (const rich of [false, true])
    for (const description of [
      "Bad Request: message to edit not found",
      "Bad Request: message can't be edited",
    ]) {
      const calls: string[] = [];
      const state: QuestionState = {
        chatId: "7",
        chatType: "private",
        conversationId: null,
        messageThreadId: null,
      };
      const tg = {
        chatId: "7",
        post: () => Promise.resolve({ id: "9", raw: {} }),
        request: (method: string) => {
          calls.push(method);
          return Promise.resolve({
            ok: method.startsWith("send"),
            status: method.startsWith("send") ? 200 : 400,
            body: method.startsWith("send")
              ? { ok: true, result: { message_id: 9 } }
              : { ok: false, description },
          });
        },
      } as unknown as TelegramHandle;
      await postTelegramQuestion(
        {
          requestId: "q",
          kind: "question",
          prompt: "Confirm?",
          action: {
            callId: "c",
            input: {},
            kind: "tool-call",
            toolName: "ask_question",
          },
          options: [{ id: "yes", label: "Yes" }],
        },
        state,
        tg,
        rich,
      );
      const before = calls.length;
      await settleTelegramQuestions(
        [
          {
            requestId: "q",
            outcome: "answered",
            response: { optionId: "yes" },
          },
        ],
        state,
        tg,
      );
      await flushSettledTelegramQuestions(state, tg);
      await flushSettledTelegramQuestions(
        JSON.parse(JSON.stringify(state)) as QuestionState,
        tg,
      );
      assert.deepEqual(calls.slice(before), ["editMessageText"]);
      assert.deepEqual(state.questionPreviews, {});
      assert.deepEqual(state.hitlCallbacks, {});
    }
});

void test("long native question retires a rejected status edit after confirmed keyboard removal", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const markupResult of ["removed", "deleted", "transient"] as const) {
    const calls: string[] = [];
    const state: QuestionState = {
      chatId: "7",
      chatType: "private",
      conversationId: null,
      messageThreadId: null,
    };
    const tg = {
      chatId: "7",
      post: () => Promise.resolve({ id: "9", raw: {} }),
      request: (method: string) => {
        calls.push(method);
        if (method === "editMessageText")
          return Promise.resolve({
            ok: false,
            status: 400,
            body: {
              ok: false,
              description: "Bad Request: message is too long",
            },
          });
        return Promise.resolve(
          markupResult === "removed"
            ? { ok: true, status: 200, body: { ok: true } }
            : {
                ok: false,
                status: markupResult === "deleted" ? 400 : 503,
                body: {
                  ok: false,
                  description:
                    markupResult === "deleted"
                      ? "Bad Request: message to edit not found"
                      : "Service unavailable",
                },
              },
        );
      },
    } as unknown as TelegramHandle;
    await postTelegramQuestion(
      {
        requestId: "q",
        kind: "question",
        prompt: "x".repeat(9000),
        action: {
          callId: "c",
          input: {},
          kind: "tool-call",
          toolName: "ask_question",
        },
        options: [{ id: "yes", label: "Yes" }],
      },
      state,
      tg,
    );
    await settleTelegramQuestions(
      [{ requestId: "q", outcome: "answered", response: { optionId: "yes" } }],
      state,
      tg,
    );
    await flushSettledTelegramQuestions(state, tg);
    if (markupResult === "transient") {
      assert.deepEqual(calls, [
        "editMessageText",
        "editMessageReplyMarkup",
        "editMessageText",
        "editMessageReplyMarkup",
      ]);
      assert.ok(state.questionPreviews?.q.settledStatus);
    } else {
      assert.deepEqual(calls, ["editMessageText", "editMessageReplyMarkup"]);
      assert.deepEqual(state.questionPreviews, {});
    }
    assert.deepEqual(state.hitlCallbacks, {});
  }
});

void test("transient preview backlog retries one edit pair per lifecycle and rotates failures", async (t) => {
  t.mock.method(console, "error", () => {});
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  const calls: Array<{ method: string; messageId: unknown }> = [];
  let id = 0;
  const tg = {
    chatId: "7",
    post: () => Promise.resolve({ id: String(++id), raw: {} }),
    request: (method: string, body: { message_id: unknown }) => {
      calls.push({ method, messageId: body.message_id });
      return Promise.resolve({ ok: false, status: 503, body: { ok: false } });
    },
  } as unknown as TelegramHandle;
  for (const requestId of ["first", "second", "third"])
    await postTelegramQuestion(
      {
        requestId,
        kind: "question",
        prompt: "Confirm?",
        action: {
          callId: "c",
          input: {},
          kind: "tool-call",
          toolName: "ask_question",
        },
        options: [{ id: "yes", label: "Yes" }],
      },
      state,
      tg,
    );
  await settleTelegramQuestions(
    ["first", "second", "third"].map((requestId) => ({
      requestId,
      outcome: "answered" as const,
      response: { optionId: "yes" },
    })),
    state,
    tg,
  );
  assert.deepEqual(calls, [
    { method: "editMessageText", messageId: "1" },
    { method: "editMessageReplyMarkup", messageId: "1" },
  ]);
  assert.deepEqual(Object.keys(state.questionPreviews!), [
    "second",
    "third",
    "first",
  ]);
  const recovered = JSON.parse(JSON.stringify(state)) as QuestionState;
  await flushSettledTelegramQuestions(recovered, tg);
  assert.deepEqual(calls.slice(2), [
    { method: "editMessageText", messageId: "2" },
    { method: "editMessageReplyMarkup", messageId: "2" },
  ]);
  assert.deepEqual(Object.keys(recovered.questionPreviews!), [
    "third",
    "first",
    "second",
  ]);
  assert.deepEqual(recovered.hitlCallbacks, {});
});

void test("one flush shares the five-second deadline across text and keyboard edits", async (t) => {
  t.mock.method(console, "error", () => {});
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const methods: string[] = [];
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
    questionPreviews: {
      q: {
        messageId: "9",
        prompt: "Confirm?",
        labels: {},
        rich: false,
        settledStatus: "Answer received",
      },
    },
  };
  const tg = {
    chatId: "7",
    request: (method: string) => {
      methods.push(method);
      return new Promise<never>(() => {});
    },
  } as unknown as TelegramHandle;
  const flushing = flushSettledTelegramQuestions(state, tg);
  now = 5000;
  t.mock.timers.tick(5000);
  await flushing;
  assert.deepEqual(methods, ["editMessageText"]);
  assert.ok(state.questionPreviews?.q.settledStatus);
});
