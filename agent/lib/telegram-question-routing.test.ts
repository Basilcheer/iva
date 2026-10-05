import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RouteHandlerArgs } from "eve/channels";
import {
  telegramChannel,
  telegramContinuationToken,
  type TelegramHandle,
  resolveTelegramInputResponses,
} from "eve/channels/telegram";
import {
  postTelegramQuestion,
  type QuestionState,
} from "./telegram-question.ts";

function eveHandle(
  chatType: QuestionState["chatType"],
  returnedChatType = chatType,
  topic: number | null = null,
) {
  const apiCalls: string[] = [];
  const channel = telegramChannel({
    credentials: { botToken: "test-token", webhookSecretToken: "test-secret" },
    api: {
      fetch: (url) => {
        const address =
          url instanceof Request
            ? url.url
            : url instanceof URL
              ? url.href
              : url;
        apiCalls.push(new URL(address).pathname.split("/").at(-1)!);
        return Promise.resolve(
          Response.json({
            ok: true,
            result: {
              message_id: 999,
              chat: { id: -7, type: returnedChatType },
            },
          }),
        );
      },
    },
  });
  const { adapter, routes } = channel as unknown as {
    adapter: {
      state: QuestionState;
      createAdapterContext: (base: {
        state: QuestionState;
        session: unknown;
        ctx: unknown;
      }) => { telegram: TelegramHandle };
    };
    routes: Array<{
      handler: (
        req: Request,
        args: RouteHandlerArgs<QuestionState>,
      ) => Promise<Response>;
    }>;
  };
  const state: QuestionState = {
    ...adapter.state,
    chatId: "-7",
    chatType,
    conversationId: "123",
    messageThreadId: topic,
  };
  const rekeys: string[] = [];
  const continuation = {
    token: telegramContinuationToken({
      chatId: -7,
      conversationId: 123,
      messageThreadId: topic ?? undefined,
    }),
    rekey: (token: string) => {
      rekeys.push(token);
    },
  };
  const { telegram } = adapter.createAdapterContext({
    state,
    session: { id: "s", continuation },
    ctx: {},
  });
  return { telegram, state, rekeys, continuation, apiCalls, route: routes[0] };
}
const question = {
  requestId: "q",
  kind: "question" as const,
  prompt: "Confirm?",
  action: {
    kind: "tool-call" as const,
    toolName: "ask_question",
    callId: "c",
    input: {},
  },
  options: [
    { id: "yes", label: "Confirm" },
    { id: "no", label: "Cancel" },
  ],
};

void test("rich questions preserve Eve post() group anchoring and native callback routing", async () => {
  for (const rich of [false, true]) {
    const h = eveHandle("supergroup");
    await postTelegramQuestion(
      question,
      h.state,
      h.telegram,
      rich,
      h.continuation,
    );
    assert.equal(h.state.conversationId, "999");
    assert.deepEqual(h.rekeys, ["-7::999"]);
    const pending: Promise<unknown>[] = [];
    let accepted = 0;
    const callback = Object.keys(h.state.hitlCallbacks ?? {})[0];
    const args = {
      from: (token: string) => {
        assert.equal(
          token,
          h.rekeys[0],
          "callback must reach the awaiting session's current continuation",
        );
        return {
          respond: (
            responses: Parameters<typeof resolveTelegramInputResponses>[1],
          ) => {
            accepted += resolveTelegramInputResponses(
              h.state,
              responses,
            ).length;
            return Promise.resolve({ id: "s" });
          },
        };
      },
      waitUntil: (task: Promise<unknown>) => {
        pending.push(task);
      },
    } as unknown as RouteHandlerArgs<QuestionState>;
    const response = await h.route.handler(
      new Request("http://iva.test/eve/v1/telegram", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "test-secret",
        },
        body: JSON.stringify({
          update_id: 1,
          callback_query: {
            id: "tap",
            from: { id: 9, is_bot: false },
            message: {
              message_id: 999,
              date: 1,
              chat: { id: -7, type: "supergroup" },
            },
            data: callback,
          },
        }),
      }),
      args,
    );
    await Promise.all(pending);
    assert.equal(response.status, 200);
    assert.equal(accepted, 1);
  }
});

void test("rich reply learns an initially unknown group type, while private questions never rekey", async () => {
  const group = eveHandle(null, "group");
  await postTelegramQuestion(
    question,
    group.state,
    group.telegram,
    true,
    group.continuation,
  );
  assert.equal(group.state.chatType, "group");
  assert.equal(group.state.conversationId, "999");
  assert.deepEqual(group.rekeys, ["-7::999"]);
  const privateChat = eveHandle("private");
  await postTelegramQuestion(
    question,
    privateChat.state,
    privateChat.telegram,
    true,
    privateChat.continuation,
  );
  assert.deepEqual(privateChat.rekeys, []);
  assert.equal(privateChat.state.conversationId, "123");
});

void test("group question without public continuation uses Eve post() anchoring", async () => {
  const h = eveHandle("group");
  await postTelegramQuestion(question, h.state, h.telegram, true);
  assert.deepEqual(h.apiCalls, ["sendMessage"]);
  assert.equal(h.state.conversationId, "999");
  assert.deepEqual(h.rekeys, ["-7::999"]);
});

void test("group and forum anchoring matches Eve's public continuation token; seed 2721", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("group" as const, "supergroup" as const),
      fc.option(fc.integer({ min: 1, max: 1000000 }), { nil: null }),
      async (chatType, topic) => {
        const h = eveHandle(chatType, chatType, topic);
        await postTelegramQuestion(
          question,
          h.state,
          h.telegram,
          true,
          h.continuation,
        );
        assert.equal(h.state.conversationId, "999");
        assert.deepEqual(h.rekeys, [
          telegramContinuationToken({
            chatId: -7,
            conversationId: 999,
            messageThreadId: topic ?? undefined,
          }),
        ]);
      },
    ),
    { seed: 2721, numRuns: 50 },
  );
});
