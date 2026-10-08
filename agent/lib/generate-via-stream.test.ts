// Сборка результата doGenerate из потока doStream: части, обрыв, ошибка, отмена.
// Провод codex (SSE Responses API → generateText) проверяет agent/provider.test.ts.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; fc.assert(prop, { seed: SEED, path }).
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { APICallError } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { generateViaStream } from "./generate-via-stream.ts";

const SEED = 20_261_008;

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 },
  outputTokens: { total: 30, text: 25, reasoning: 5 },
};
const NO_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};
const FINISH: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: undefined },
  usage: USAGE,
  providerMetadata: { openai: { responseId: "resp_1" } },
};

function streamOf(parts: LanguageModelV4StreamPart[]) {
  return () =>
    Promise.resolve<LanguageModelV4StreamResult>({
      stream: convertArrayToReadableStream(parts),
      request: { body: { stream: true } },
      response: { headers: { "x-request-id": "req_1" } },
    });
}

await test("части потока собираются в content по порядку, метаданные — последние непустые", async () => {
  const result = await generateViaStream(
    streamOf([
      { type: "stream-start", warnings: [{ type: "other", message: "w" }] },
      {
        type: "response-metadata",
        id: "resp_1",
        modelId: "gpt-6-luna",
        timestamp: new Date(0),
      },
      {
        type: "reasoning-start",
        id: "r",
        providerMetadata: { openai: { itemId: "rs_1" } },
      },
      { type: "reasoning-delta", id: "r", delta: "думаю " },
      { type: "reasoning-delta", id: "r", delta: "дальше" },
      {
        type: "reasoning-end",
        id: "r",
        providerMetadata: { openai: { itemId: "rs_1", enc: "E" } },
      },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "При" },
      { type: "raw", rawValue: {} },
      { type: "text-delta", id: "t", delta: "вет" },
      { type: "text-end", id: "t" },
      { type: "tool-input-start", id: "c1", toolName: "remind" },
      { type: "tool-input-delta", id: "c1", delta: "{}" },
      { type: "tool-input-end", id: "c1" },
      { type: "tool-call", toolCallId: "c1", toolName: "remind", input: "{}" },
      FINISH,
    ]),
  );
  assert.deepEqual(result.content, [
    {
      type: "reasoning",
      text: "думаю дальше",
      providerMetadata: { openai: { itemId: "rs_1", enc: "E" } },
    },
    { type: "text", text: "Привет" },
    { type: "tool-call", toolCallId: "c1", toolName: "remind", input: "{}" },
  ]);
  assert.deepEqual(result.finishReason, { unified: "stop", raw: undefined });
  assert.deepEqual(result.usage, USAGE);
  assert.deepEqual(result.providerMetadata, {
    openai: { responseId: "resp_1" },
  });
  assert.deepEqual(result.warnings, [{ type: "other", message: "w" }]);
  assert.deepEqual(result.request, { body: { stream: true } });
  assert.deepEqual(result.response, {
    id: "resp_1",
    modelId: "gpt-6-luna",
    timestamp: new Date(0),
    headers: { "x-request-id": "req_1" },
  });
});

// @ai-sdk/openai в flush дописывает такой finish и в пустой поток (200 с одним [DONE],
// пустое тело, обрыв после reasoning до message).
const SYNTHETIC_FINISH: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "other", raw: undefined },
  usage: NO_USAGE,
  providerMetadata: { openai: { responseId: null } },
};

await test("пустой поток с синтезированным finish — исключение, пустой ответ итогом не становится", async () => {
  for (const parts of [
    [SYNTHETIC_FINISH],
    [{ type: "stream-start", warnings: [] }, SYNTHETIC_FINISH],
    [
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "думаю" },
      { type: "reasoning-end", id: "r" },
      SYNTHETIC_FINISH,
    ],
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: " \n " },
      { type: "text-end", id: "t" },
      SYNTHETIC_FINISH,
    ],
  ] satisfies LanguageModelV4StreamPart[][])
    await assert.rejects(
      generateViaStream(streamOf(parts)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^model stream ended without an answer: finish other, \d+ parts, reasoning (yes|no)$/u,
        );
        assert.ok(error.cause, "собранный результат лежит в cause");
        return true;
      },
    );
});

await test("вызов инструмента без текста — ответ", async () => {
  const result = await generateViaStream(
    streamOf([
      { type: "tool-call", toolCallId: "c1", toolName: "remind", input: "{}" },
      SYNTHETIC_FINISH,
    ]),
  );
  assert.equal(result.content.length, 1);
});

await test("finish без usage, но с непустым текстом: результат с пустым usage, вызов проходит", async () => {
  const result = await generateViaStream(
    streamOf([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "итог" },
      { type: "text-end", id: "t" },
      { ...FINISH, usage: NO_USAGE },
    ]),
  );
  assert.deepEqual(result.content, [{ type: "text", text: "итог" }]);
  assert.deepEqual(result.usage, NO_USAGE);
});

await test("отказ до первой части: та же APICallError, что у doStream", async () => {
  const refusal = new APICallError({
    message: "Bad Request",
    url: "https://example.test/responses",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"detail":"Stream must be set to true"}',
  });
  await assert.rejects(
    generateViaStream(() => Promise.reject(refusal)),
    (error) => error === refusal,
  );
});

await test("error-часть: исключение той же ошибки, объект провайдера — с телом в тексте", async () => {
  const thrown = new Error("socket hang up");
  await assert.rejects(
    generateViaStream(
      streamOf([
        { type: "text-start", id: "t" },
        { type: "error", error: thrown },
        FINISH,
      ]),
    ),
    (error) => error === thrown,
  );
  await assert.rejects(
    generateViaStream(
      streamOf([
        {
          type: "error",
          error: {
            type: "error",
            code: "rate_limit_exceeded",
            message: "slow",
          },
        },
        FINISH,
      ]),
    ),
    /model stream failed: .*rate_limit_exceeded/u,
  );
});

await test("обрыв: незакрытый текст или поток без finish — исключение, не частичный итог", async () => {
  for (const parts of [
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "полов" },
      FINISH,
    ],
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "половина" },
      { type: "text-end", id: "t" },
    ],
  ] satisfies LanguageModelV4StreamPart[][])
    await assert.rejects(
      generateViaStream(streamOf(parts)),
      /ended before the answer was finished/u,
    );

  const broken = new TypeError("terminated");
  let sent = false;
  await assert.rejects(
    generateViaStream(() =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            if (sent) return controller.error(broken);
            sent = true;
            controller.enqueue({ type: "text-start", id: "t" });
          },
        }),
      }),
    ),
    (error) => error === broken,
  );
});

await test("abortSignal: поток закрывается, исключение AbortError", async () => {
  const controller = new AbortController();
  let cancelled: unknown = "not cancelled";
  const pending = generateViaStream(
    () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(stream) {
            stream.enqueue({ type: "text-start", id: "t" });
          },
          cancel(reason) {
            cancelled = reason;
          },
        }),
      }),
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((cancelled as Error).name, "AbortError");

  let called = false;
  await assert.rejects(
    generateViaStream(() => {
      called = true;
      return streamOf([FINISH])();
    }, AbortSignal.abort()),
    { name: "AbortError" },
  );
  assert.equal(called, false, "уже отменённый вызов не идёт к провайдеру");
});

await test(`дельты, разбросанные между частями, склеиваются по своим id (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.array(fc.string(), { maxLength: 6 }), {
        minLength: 1,
        maxLength: 4,
      }),
      fc.infiniteStream(fc.nat()),
      async (texts, picks) => {
        // Каждая часть открывается заранее, дельты разных частей перемешаны, закрытие в конце.
        const ids = texts.map((_, index) => `p${String(index)}`);
        const queues = texts.map((deltas) => [...deltas]);
        const deltas: LanguageModelV4StreamPart[] = [];
        const pick = picks[Symbol.iterator]();
        for (;;) {
          const live = queues
            .map((queue, index) => (queue.length > 0 ? index : -1))
            .filter((index) => index >= 0);
          if (live.length === 0) break;
          const index = live[(pick.next().value as number) % live.length];
          deltas.push({
            type: "text-delta",
            id: ids[index],
            delta: queues[index].shift()!,
          });
        }
        const call = generateViaStream(
          streamOf([
            ...ids.map((id) => ({ type: "text-start" as const, id })),
            ...deltas,
            ...ids.map((id) => ({ type: "text-end" as const, id })),
            FINISH,
          ]),
        );
        // Только пробельный текст во всех частях — не ответ.
        if (texts.every((parts) => parts.join("").trim() === "")) {
          await assert.rejects(call, /ended without an answer/u);
          return;
        }
        const result = await call;
        assert.deepEqual(
          result.content,
          texts.map((parts) => ({ type: "text", text: parts.join("") })),
        );
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});
