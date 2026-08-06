import assert from "node:assert/strict";
import test from "node:test";

type Transport = {
  readCappedStream: (body: unknown, maxBytes: number) => Promise<string | null>;
};

const transportModulePath = "./transport.mjs";
const { readCappedStream } = (await import(transportModulePath)) as Transport;
const encoder = new TextEncoder();

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
      read: async (): Promise<never> => Promise.reject(new Error("read failed")),
      cancel: async () => undefined,
    }),
  };
  assert.equal(await readCappedStream(body, 4), null);
});
