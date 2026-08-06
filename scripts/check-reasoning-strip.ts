// Self-check: withReasoningStripped выкидывает reasoning из вывода модели (generate + stream),
// сохраняя текст. Это анти-InvalidPrompt-инвариант (см. agent/provider.ts).
// Запуск: node scripts/check-reasoning-strip.ts
import assert from "node:assert/strict";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { withReasoningStripped } from "../agent/provider.ts";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
} as unknown as LanguageModelV4Usage;

// generate: textless reasoning (ровно то, что валит ModelMessage-схему) должен исчезнуть, текст остаться
const genModel = withReasoningStripped(
  new MockLanguageModelV4({
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async fixture shape.
    doGenerate: async () =>
      ({
        finishReason: "stop",
        usage,
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "привет" },
        ],
        warnings: [],
      }) as unknown as LanguageModelV4GenerateResult,
  }),
);
const gen = await generateText({ model: genModel, prompt: "hi" });
assert.equal(
  gen.reasoningText ?? "",
  "",
  "generate: reasoning не должен дойти до результата",
);
assert.equal(gen.text, "привет", "generate: текст должен сохраниться");

// stream: reasoning-* части не должны попасть в стрим, текст — должен
const streamModel = withReasoningStripped(
  new MockLanguageModelV4({
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async fixture shape.
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "думаю" },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ответ" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage },
        ]),
      }) as unknown as LanguageModelV4StreamResult,
  }),
);
const res = streamText({ model: streamModel, prompt: "hi" });
let text = "";
let reasoningSeen = false;
for await (const part of res.fullStream) {
  if (part.type === "text-delta") text += part.text;
  if (part.type.startsWith("reasoning")) reasoningSeen = true;
}
assert.equal(
  reasoningSeen,
  false,
  "stream: reasoning-части должны быть вырезаны",
);
assert.equal(text, "ответ", "stream: текст должен сохраниться");

console.log("OK reasoning-strip: generate + stream");
