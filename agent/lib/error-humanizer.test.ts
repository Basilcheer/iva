/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { humanizeProviderError } from "./error-humanizer.ts";

const REAL_LIMIT_ERROR =
  "AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: 5-hour usage limit reached. Resets in 3hr 59min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_.../go";
const REAL_UPSTREAM_ERROR =
  "AI_APICallError: Error from provider (Console Go): Upstream request failed";

test("humanizes the production usage-limit error and preserves its reset interval", () => {
  assert.deepEqual(humanizeProviderError({ message: REAL_LIMIT_ERROR }), {
    en: "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model",
    ru: "Лимит провайдера исчерпан - сброс через 3hr 59min; подожди или смени модель: /model",
  });
});

test("humanizes the production upstream failure", () => {
  assert.deepEqual(humanizeProviderError({ message: REAL_UPSTREAM_ERROR }), {
    en: "The provider has a failure on its side. Write again in a couple of minutes.",
    ru: "У провайдера сбой. Напиши ещё раз через пару минут.",
  });
});

test("recognizes limits from prose, structured statusCode details and reset text", () => {
  assert.equal(
    humanizeProviderError({
      message: "Request rejected",
      details: {
        statusCode: 429,
        upstreamMessage: "Rate limit. Resets in 12 min",
      },
    }).ru,
    "Лимит провайдера исчерпан - сброс через 12 min; подожди или смени модель: /model",
  );
  assert.equal(
    humanizeProviderError({ message: "rate_limit_exceeded" }).en,
    "Provider limit exhausted - wait or switch models: /model",
  );
});

test("recognizes exhausted balance or plan", () => {
  for (const input of [
    { message: "insufficient credits" },
    { message: "Account billing is inactive" },
    { message: "Request failed", details: { statusCode: 402 } },
  ]) {
    assert.deepEqual(humanizeProviderError(input), {
      en: "Provider balance/plan exhausted - top up or switch models: /model",
      ru: "Баланс/тариф провайдера исчерпан - пополни или смени модель: /model",
    });
  }
});

test("refused credentials say who refused and where to fix it, without repeats", () => {
  for (const input of [
    { message: "Invalid API key" },
    { message: "Unauthorized" },
    { message: "Request rejected", details: '{"statusCode":403}' },
    {
      message: "api.anthropic.com did not finish the response (HTTP 401)",
      details: { attempts: 1 },
    },
  ]) {
    assert.deepEqual(humanizeProviderError({ ...input, provider: "claude" }), {
      en: "Anthropic did not accept the key or login. Check it in /menu and write again.",
      ru: "Anthropic не принял ключ или вход. Проверь его в /menu и напиши ещё раз.",
    });
  }
  assert.equal(
    humanizeProviderError({ message: "Unauthorized" }).ru,
    "Провайдер не принял ключ или вход. Проверь его в /menu и напиши ещё раз.",
  );
});

// Ночь c1 07.10.2026 дословно: eve повторила шаг три раза, связь так и не вернулась.
const C1_BREAK =
  "api.anthropic.com did not finish the response (the stream broke off before message_stop): API Error: Connection to the API was lost (StreamTruncated)";

test("a broken connection after all attempts names the provider and the repeats", () => {
  assert.deepEqual(
    humanizeProviderError({
      message: C1_BREAK,
      details: { attempts: 3, errorId: "e-1" },
      provider: "claude",
    }),
    {
      en: "The connection to Anthropic broke off. I tried again 2 times, it did not work. Write again.",
      ru: "Связь с Anthropic оборвалась, повторила 2 раза, не получилось. Напиши ещё раз.",
    },
  );
  for (const message of [
    "Request timeout",
    "read ECONNRESET",
    "connect ETIMEDOUT",
    "TypeError: fetch failed",
    "The response stream was aborted",
    "terminated",
  ]) {
    assert.equal(
      humanizeProviderError({ message, provider: "codex" }).ru,
      "Связь с OpenAI оборвалась. Напиши ещё раз.",
    );
  }
});

test("a stream broken in the middle of the answer offers one Try again button", () => {
  const text = humanizeProviderError({
    message: C1_BREAK,
    details: { attempts: 1, answerStarted: true, errorId: "e-2" },
    provider: "claude",
  });
  assert.equal(
    text.ru,
    'Связь с Anthropic оборвалась на середине ответа. Повторить?\n\n<tg-button-row><tg-button type="callback_data" data="Повторить">Повторить</tg-button></tg-button-row>',
  );
  assert.match(text.en, /in the middle of the answer\. Try again\?/u);
  assert.match(text.en, /data="Try again">Try again</u);
});

test("provider-side failures and no network at all say what to do", () => {
  for (const input of [
    { message: "The service is overloaded" },
    { message: "Internal Server Error" },
    { message: "Provider returned a 5xx response" },
    { message: "Request failed", details: { upstreamStatusCode: 503 } },
  ]) {
    assert.equal(
      humanizeProviderError({
        ...input,
        details: input.details,
        provider: "ollama",
      }).ru,
      "У Ollama сбой. Напиши ещё раз через пару минут.",
    );
  }
  assert.equal(
    humanizeProviderError({
      message: "getaddrinfo ENOTFOUND api.openai.com",
      details: { attempts: 3 },
      provider: "codex",
    }).ru,
    "Не могу достучаться до OpenAI: у сервера нет связи с ним, повторила 2 раза, не получилось. Проверь интернет на сервере и напиши ещё раз.",
  );
});

test("Russian count agrees with the number of repeats", () => {
  const ru = (attempts: number) =>
    humanizeProviderError({ message: "terminated", details: { attempts } }).ru;
  assert.match(ru(2), /повторила 1 раз,/u);
  assert.match(ru(3), /повторила 2 раза,/u);
  assert.match(ru(6), /повторила 5 раз,/u);
  assert.match(ru(13), /повторила 12 раз,/u);
  assert.match(ru(23), /повторила 22 раза,/u);
  for (const attempts of [0, 1, -1, 1.5, Number.NaN])
    assert.equal(
      ru(attempts),
      "Связь с провайдером оборвалась. Напиши ещё раз.",
    );
});

test("context overflow names the way out", () => {
  for (const message of [
    "context length exceeded",
    "too many tokens in prompt",
    "maximum context window reached",
  ]) {
    assert.deepEqual(humanizeProviderError({ message }), {
      en: "The conversation got too long for the model. /new starts over.",
      ru: "Разговор стал слишком длинным для модели. /new начнёт заново.",
    });
  }
});

test("an unknown failure is told in words, the provider text stays out of the chat", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 8 }), (raw) => {
      const message = `Q${raw}\nsecond line`;
      const text = humanizeProviderError({
        message,
        details: { errorId: "e-77", diagnostic: raw },
      });
      for (const said of [text.en, text.ru]) {
        assert.equal(said.includes("e-77"), false);
        assert.equal(said.includes("second line"), false);
      }
    }),
  );
  assert.deepEqual(
    humanizeProviderError({
      message:
        "AI_RetryError: Failed after 2 attempts. Last error: Provider returned a strange response",
      provider: "openrouter",
    }),
    {
      en: "I could not answer: OpenRouter returned something I could not read. Write again; if it repeats, /new starts over.",
      ru: "Не получилось ответить: OpenRouter вернул ответ, который я не разобрала. Напиши ещё раз; если повторится, /new начнёт заново.",
    },
  );
});

test("a tool schema the provider rejects names the plugin switch, not the schema", () => {
  // Дословно из пакета t0uchY 13.09.2026: OpenAI отверг весь запрос из-за одного инструмента.
  const text = humanizeProviderError({
    message:
      "AI_APICallError: Invalid JSON schema: regex lookaround is not supported. Found at $.properties.attendees.items.pattern.",
    details: { statusCode: 400, upstreamType: "invalid_request_error" },
  });
  assert.match(text.ru, /attendees\.items\.pattern/u);
  assert.match(text.ru, /data\/custom\/agent\/tools/u);
  assert.match(text.en, /iva plugin disable/u);
});
