import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  type TelegramHandle,
  resolveTelegramInputResponses,
  telegramCallbackInputResponse,
} from "eve/channels/telegram";
import {
  postTelegramQuestion,
  settleTelegramQuestions,
  flushSettledTelegramQuestions,
  type QuestionState,
} from "./telegram-question.ts";

for (const seed of [272, 20261005, 424242]) {
  void test(`accepted choice survives failed delivery, duplicates and JSON recovery; seed ${seed}`, async (t) => {
    t.mock.method(console, "error", () => {});
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("q", "__proto__", "constructor", "вопрос"),
        fc.boolean(),
        fc.constantFrom("yes", "no"),
        fc.array(
          fc.record({
            restart: fc.boolean(),
            success: fc.boolean(),
            duplicate: fc.boolean(),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        async (requestId, rich, accepted, operations) => {
          let state: QuestionState = {
            chatId: "7",
            chatType: "private",
            conversationId: null,
            messageThreadId: 42,
          };
          const calls: Array<{
            method: string;
            body: Record<string, unknown>;
          }> = [];
          let success = true;
          const tg = {
            chatId: "7",
            messageThreadId: 42,
            post: (body: Record<string, unknown>) => {
              calls.push({ method: "sendMessage", body });
              return Promise.resolve({ id: "9", raw: {} });
            },
            request: (method: string, body: Record<string, unknown>) => {
              calls.push({ method, body });
              return Promise.resolve({
                ok: success,
                status: success ? 200 : 503,
                body: { ok: success, result: { message_id: 9 } },
              });
            },
          } as unknown as TelegramHandle;
          await postTelegramQuestion(
            {
              requestId,
              kind: "question",
              prompt: "Confirm?",
              allowFreeform: true,
              action: {
                callId: "c",
                input: {},
                kind: "tool-call",
                toolName: "ask_question",
              },
              options: [
                { id: "yes", label: "Confirm" },
                { id: "no", label: "Cancel" },
              ],
            },
            state,
            tg,
            rich,
          );
          const callback = Object.entries(state.hitlCallbacks ?? {}).find(
            ([, response]) => response.optionId === accepted,
          )![0];
          // Eve accepts the answer once. UI recovery cannot reintroduce callback mappings.
          const input = telegramCallbackInputResponse(callback);
          assert.equal(resolveTelegramInputResponses(state, [input]).length, 1);
          const sends = calls.filter(({ method }) =>
            method.startsWith("send"),
          ).length;
          success = false;
          await settleTelegramQuestions(
            [
              {
                requestId,
                outcome: "answered",
                response: { optionId: accepted },
              },
            ],
            state,
            tg,
          );
          const originalStatus =
            state.questionPreviews![requestId].settledStatus;
          for (const operation of operations) {
            if (operation.restart)
              state = JSON.parse(JSON.stringify(state)) as QuestionState;
            success = operation.success;
            if (operation.duplicate)
              await settleTelegramQuestions(
                [
                  {
                    requestId,
                    outcome: "denied",
                    response: {
                      optionId: accepted === "yes" ? "no" : "yes",
                      text: "private-freeform-value",
                    },
                  },
                ],
                state,
                tg,
              );
            else await flushSettledTelegramQuestions(state, tg);
            assert.equal(
              resolveTelegramInputResponses(state, [input]).length,
              0,
            );
            assert.deepEqual(state.hitlCallbacks, {});
            assert.deepEqual(state.pendingFreeformReplies, {});
            if (
              state.questionPreviews &&
              Object.hasOwn(state.questionPreviews, requestId)
            )
              assert.equal(
                state.questionPreviews[requestId].settledStatus,
                originalStatus,
              );
          }
          success = true;
          await flushSettledTelegramQuestions(state, tg);
          assert.deepEqual(state.questionPreviews, {});
          assert.equal(
            calls.filter(({ method }) => method.startsWith("send")).length,
            sends,
          );
          const edited = calls.filter(
            ({ method }) => method === "editMessageText",
          );
          assert.ok(edited.length);
          for (const { body } of edited) {
            assert.equal(body.message_id, rich ? 9 : "9");
            assert.deepEqual(body.reply_markup, { inline_keyboard: [] });
            const text = rich
              ? (body.rich_message as { markdown: string }).markdown
              : String(body.text);
            assert.match(text, accepted === "yes" ? /Confirm$/u : /Cancel$/u);
            assert.doesNotMatch(text, /tg-button|private-freeform-value/u);
          }
        },
      ),
      { seed, numRuns: 40 },
    );
  });
}

void test("only definite HTTP 400 unavailable messages retire previews; seed 2722", async (t) => {
  t.mock.method(console, "error", () => {});
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(200, 400, 401, 403, 429, 500, 503),
      fc.constantFrom(
        "Bad Request: message to edit not found",
        "Bad Request: message can't be edited",
      ),
      fc.boolean(),
      async (status, description, rich) => {
        const state: QuestionState = {
          chatId: "7",
          chatType: "private",
          conversationId: null,
          messageThreadId: null,
        };
        let edits = 0;
        const tg = {
          chatId: "7",
          post: () => Promise.resolve({ id: "9", raw: {} }),
          request: (method: string) => {
            if (method.startsWith("send"))
              return Promise.resolve({
                ok: true,
                status: 200,
                body: { ok: true, result: { message_id: 9 } },
              });
            edits++;
            return Promise.resolve({
              ok: false,
              status,
              body: { ok: false, description },
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
            options: [{ id: "yes", label: "Confirm" }],
          },
          state,
          tg,
          rich,
        );
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
        const before = edits;
        await flushSettledTelegramQuestions(state, tg);
        if (status === 400) {
          assert.deepEqual(state.questionPreviews, {});
          assert.equal(edits, before);
        } else {
          assert.ok(state.questionPreviews?.q.settledStatus);
          assert.ok(edits > before);
        }
        assert.deepEqual(state.hitlCallbacks, {});
      },
    ),
    { seed: 2722, numRuns: 50 },
  );
});
