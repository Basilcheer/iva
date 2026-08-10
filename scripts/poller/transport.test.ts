/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import assert from "node:assert/strict";
import test from "node:test";

type Transport = {
  readCappedStream: (body: unknown, maxBytes: number) => Promise<string | null>;
  tg: (method: string, body: unknown) => Promise<unknown>;
  reply: (chatId: number | string, text: string) => Promise<unknown>;
  edit: (
    chatId: number | string,
    messageId: number,
    text: string,
  ) => Promise<unknown>;
};

const transportModulePath = "./transport.ts";
const { readCappedStream, tg, reply, edit } = (await import(
  transportModulePath
)) as Transport;
const encoder = new TextEncoder();

const PLANTED = `api_key=${"z".repeat(24)}`;

// Records what the bridge would actually put on the wire.
function captureFetch(t: {
  after: (fn: () => void) => void;
}): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return { json: async () => ({ ok: true, result: { message_id: 5 } }) };
  }) as unknown as typeof fetch;
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });
  return bodies;
}

function streamOf(...parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

test("readCappedStream keeps an exactly capped UTF-8 body", async () => {
  assert.equal(await readCappedStream(streamOf("test"), 4), "test");
  assert.equal(await readCappedStream(streamOf("€"), 3), "€");
});

test("readCappedStream cancels and rejects an oversized body before buffering the rest", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("12345"));
    },
    cancel() {
      cancelled = true;
    },
  });

  assert.equal(await readCappedStream(body, 4), null);
  assert.equal(cancelled, true);
});

test("readCappedStream returns null when its reader fails", async () => {
  const body = {
    getReader: () => ({
      read: async (): Promise<never> =>
        Promise.reject(new Error("read failed")),
      cancel: async () => undefined,
    }),
  };
  assert.equal(await readCappedStream(body, 4), null);
});

// The bridge speaks to Telegram through tg() and nothing else, so this is the one place
// a leaked secret can be stopped for every screen at once (the rule: agent/lib/outbox.ts).
test("every Bot API call the bridge makes leaves with its text gated", async (t) => {
  const bodies = captureFetch(t);

  await tg("editMessageText", {
    chat_id: 1,
    message_id: 2,
    text: `⚠️ Есть проблемы · 00:03\n\ndoctor: ${PLANTED}\nexit 1`,
  });
  await tg("sendPhoto", { chat_id: 1, caption: `snapshot ${PLANTED}` });
  await reply(1, `reply ${PLANTED}`);
  await edit(1, 2, `edit ${PLANTED}`);

  const wire = JSON.stringify(bodies);
  assert.doesNotMatch(wire, /zzzz/u);
  assert.equal(bodies.length, 4);
  assert.equal(
    bodies[0].text,
    "⚠️ Есть проблемы · 00:03\n\ndoctor: [REDACTED]\nexit 1",
  );
  assert.equal(bodies[1].caption, "snapshot [REDACTED]");
  assert.equal(bodies[2].text, "reply [REDACTED]");
  assert.equal(bodies[3].text, "edit [REDACTED]");
});

// The same wire, carrying the shapes this installation's keys actually have: an
// OpenRouter key out of .env and an embedding key out of a nightly index run.
const OPENROUTER_KEY = `sk-or-v1-${"4f9c1e77ab3d5602".repeat(4)}`;
const JINA_KEY = `jina_${"7d2fA9bC".repeat(8)}`;

test("a real provider key shape is gated on the bridge's wire too", async (t) => {
  const bodies = captureFetch(t);

  await tg("editMessageText", {
    chat_id: 1,
    message_id: 2,
    text: `⚠️ Есть проблемы · 00:07\n\ndoctor: model call failed with ${OPENROUTER_KEY}\nexit 1`,
  });
  await reply(1, `embed-index: ${JINA_KEY} rejected`);

  const wire = JSON.stringify(bodies);
  assert.doesNotMatch(wire, /sk-or-v1|4f9c1e77|jina_|7d2fA9bC/u);
  assert.equal(
    bodies[0].text,
    "⚠️ Есть проблемы · 00:07\n\ndoctor: model call failed with [REDACTED]\nexit 1",
  );
  assert.equal(bodies[1].text, "embed-index: [REDACTED] rejected");
});

test("a call with nothing for the chat goes out untouched", async (t) => {
  const bodies = captureFetch(t);

  await tg("getUpdates", { offset: 9, timeout: 50 });
  await tg("deleteMessage", { chat_id: 1, message_id: 2 });
  await tg("answerCallbackQuery", { callback_query_id: "q" });

  assert.deepEqual(bodies, [
    { offset: 9, timeout: 50 },
    { chat_id: 1, message_id: 2 },
    { callback_query_id: "q" },
  ]);
});
