import { test } from "node:test";
import assert from "node:assert/strict";

// telegram-poll.mjs reads env at import and guards its poll loop behind a direct-execution check,
// so importing it here is side-effect-free. A dummy token keeps the API base a harmless string.
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
const { readCappedStream, handleAwaitNonText } = await import("./telegram-poll.mjs");

const enc = new TextEncoder();
function streamOf(...parts) {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(typeof p === "string" ? enc.encode(p) : p);
      controller.close();
    },
  });
}

// A recording double for handleAwaitNonText's I/O: captures call order, returns fixed content.
// deleteOk controls whether the (mocked) Telegram deletion is reported as successful.
function recorder(content = '{"installed":{}}', { deleteOk = true } = {}) {
  const calls = [];
  const io = {
    deleteSecret: async (_c, id) => { calls.push(["delete", id]); return deleteOk; },
    reply: async (_c, text) => { calls.push(["reply", text]); },
    download: async (fileId) => { calls.push(["download", fileId]); return content; },
    deliver: async (text) => { calls.push(["deliver", text]); },
  };
  return { calls, io, names: () => calls.map((c) => c[0]) };
}

test("readCappedStream reads a small body under the cap", async () => {
  assert.equal(await readCappedStream(streamOf('{"installed":{}}'), 1024), '{"installed":{}}');
});

test("readCappedStream: oversized body with NO metadata → null (hard cap mid-stream)", async () => {
  const chunk = "x".repeat(1000);
  assert.equal(await readCappedStream(streamOf(chunk, chunk, chunk), 2048), null);
});

test("readCappedStream: exactly at the cap allowed, one over rejected; null body → null", async () => {
  assert.equal(await readCappedStream(streamOf("abcd"), 4), "abcd");
  assert.equal(await readCappedStream(streamOf("abcde"), 4), null);
  assert.equal(await readCappedStream(null, 1024), null);
});

test("file-capable secret: message is DELETED BEFORE the download, then content delivered", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 42, document: { file_id: "F", file_size: 100 } };
  const pending = { flow: "menu", awaitText: { secret: true, file: true, kind: "gwsjson" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true); // consumed → handleControl won't deliver it to eve
  assert.deepEqual(r.names(), ["delete", "download", "deliver"]);
  assert.ok(r.names().indexOf("delete") < r.names().indexOf("download"), "delete must precede download");
});

test("failed deletion → the secret is NOT downloaded or delivered (still consumed)", async () => {
  const r = recorder('{"installed":{}}', { deleteOk: false });
  const msg = { chat: { id: 1 }, message_id: 42, document: { file_id: "F", file_size: 100 } };
  const pending = { flow: "menu", awaitText: { secret: true, file: true, kind: "gwsjson" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true); // never reaches eve
  assert.deepEqual(r.names(), ["delete"]); // deletion failed → no download, no deliver
});

test("over-size document is deleted and never downloaded", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 9, document: { file_id: "F", file_size: 999_999 } };
  const pending = { flow: "menu", awaitText: { secret: true, file: true, kind: "gwsjson" } };
  await handleAwaitNonText(msg, pending, r.io);
  assert.deepEqual(r.names(), ["delete", "reply"]); // no download
});

test("secret prompt + non-file attachment (photo) → deleted with an ack, not delivered to eve", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 7 }; // no .document → a photo/sticker/etc
  const pending = { flow: "menu", awaitText: { secret: true, kind: "apikey" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true);
  assert.deepEqual(r.names(), ["delete", "reply"]); // deleted + told how to send; never reaches eve
});
