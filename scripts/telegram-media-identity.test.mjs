import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { addTelegramQueueReceipt } from "../agent/lib/telegram-acceptance.mjs";

const root = mkdtempSync(join(tmpdir(), "iva-media-identity-test-"));
const dataDir = join(root, "data");
const vaultDir = join(root, "vault");
const WEBHOOK_SECRET = "media-identity-secret";
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_VAULT_DIR = vaultDir;
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "999:media-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_USERNAME = "my_bot";
process.env.AGENT_LANGUAGE = "en";
process.env.MODEL_PROVIDER = "openrouter";
process.env.OPENROUTER_API_KEY = "test-provider-key";

const counts = { download: 0, vision: 0, transcript: 0, turns: 0 };
let visionText = "derived once";
let visionStatus = 200;
let transcriptText = "transcribed once";
let transcriptStatus = 200;
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.endsWith("/getFile")) {
    return Response.json({
      ok: true,
      result: { file_path: "photos/test.jpg" },
    });
  }
  if (url.includes("/file/bot")) {
    counts.download++;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }
  if (url.endsWith("/chat/completions")) {
    counts.vision++;
    if (visionStatus !== 200)
      return new Response("provider unavailable", { status: visionStatus });
    return Response.json({ choices: [{ message: { content: visionText } }] });
  }
  if (url.startsWith("https://api.deepgram.com/v1/listen")) {
    counts.transcript++;
    if (transcriptStatus !== 200)
      return new Response("provider unavailable", { status: transcriptStatus });
    return Response.json({
      results: {
        channels: [{ alternatives: [{ transcript: transcriptText }] }],
      },
    });
  }
  return Response.json({ ok: true, result: { message_id: 1000 } });
};

const channel = (
  await import("../agent/channels/telegram.ts?media-identity-test")
).default;
const route = channel.routes.find(
  (candidate) => candidate.path === "/eve/v1/telegram/accepted",
);
assert.ok(route && route.transport !== "websocket");

after(() => rmSync(root, { recursive: true, force: true }));

function mediaUpdate(updateId, fileUniqueId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 7, type: "private" },
      from: { id: 9, is_bot: false, first_name: "Owner" },
      photo: [{ file_id: `file-${updateId}`, file_unique_id: fileUniqueId }],
    },
  };
}

function voiceUpdate(updateId, fileUniqueId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 7, type: "private" },
      from: { id: 9, is_bot: false, first_name: "Owner" },
      voice: {
        file_id: `voice-${updateId}`,
        file_unique_id: fileUniqueId,
        duration: 1,
        mime_type: "audio/ogg",
        file_size: 3,
      },
    },
  };
}

async function deliver(update) {
  const response = await route.handler(
    new Request("http://iva.test/eve/v1/telegram/accepted", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(addTelegramQueueReceipt(update)),
    }),
    {
      send: async () => {
        counts.turns++;
        return { id: `session-${update.update_id}` };
      },
      resolveActiveSession: async () => undefined,
      cancel: async () => ({ status: "no_active_turn" }),
      reset: async () => ({ status: "no_active_session" }),
      getSession: () => {
        throw new Error("not used");
      },
      receive: async () => {
        throw new Error("not used");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    },
  );
  assert.equal(response.status, 204);
  return response.headers.get("x-iva-telegram-acceptance");
}

function dailyEntries() {
  const dailyDir = join(vaultDir, "daily");
  if (!existsSync(dailyDir)) return 0;
  return (
    readdirSync(dailyDir)
      .map((name) => readFileSync(join(dailyDir, name), "utf8"))
      .join("\n")
      .match(/## .* \[photo\]/gu)?.length ?? 0
  );
}

test("three deliveries create one media derivation, while a new update reuses the file", async () => {
  const before = { ...counts, daily: dailyEntries() };
  assert.equal(await deliver(mediaUpdate(701, "stable-photo")), "turn");
  assert.equal(await deliver(mediaUpdate(701, "stable-photo")), "handled");
  assert.equal(await deliver(mediaUpdate(701, "stable-photo")), "handled");
  assert.equal(counts.download - before.download, 1);
  assert.equal(counts.vision - before.vision, 1);
  assert.equal(counts.turns - before.turns, 1);
  assert.equal(dailyEntries() - before.daily, 1);

  assert.equal(await deliver(mediaUpdate(702, "stable-photo")), "turn");
  assert.equal(counts.download - before.download, 1);
  assert.equal(counts.vision - before.vision, 1);
  assert.equal(counts.turns - before.turns, 2);
  assert.equal(dailyEntries() - before.daily, 2);
});

test("an empty vision result is cached and does not trigger another provider call", async () => {
  const before = { ...counts, daily: dailyEntries() };
  visionText = "";
  assert.equal(await deliver(mediaUpdate(703, "empty-vision-photo")), "turn");
  assert.equal(await deliver(mediaUpdate(704, "empty-vision-photo")), "turn");
  assert.equal(counts.download - before.download, 1);
  assert.equal(counts.vision - before.vision, 1);
  assert.equal(counts.turns - before.turns, 2);
  assert.equal(dailyEntries() - before.daily, 2);

  const cache = JSON.parse(
    readFileSync(join(dataDir, "media-cache.json"), "utf8"),
  );
  assert.equal(cache["empty-vision-photo"].vision, "");
});

test("a failed vision result is not cached and the next delivery retries the provider", async () => {
  const before = { ...counts, daily: dailyEntries() };
  visionStatus = 503;
  assert.equal(await deliver(mediaUpdate(705, "failed-vision-photo")), "turn");

  let cache = JSON.parse(
    readFileSync(join(dataDir, "media-cache.json"), "utf8"),
  );
  assert.equal(cache["failed-vision-photo"].vision, undefined);

  visionStatus = 200;
  visionText = "derived after retry";
  assert.equal(await deliver(mediaUpdate(706, "failed-vision-photo")), "turn");
  assert.equal(counts.download - before.download, 1);
  assert.equal(counts.vision - before.vision, 2);
  assert.equal(counts.turns - before.turns, 2);
  assert.equal(dailyEntries() - before.daily, 2);

  cache = JSON.parse(readFileSync(join(dataDir, "media-cache.json"), "utf8"));
  assert.equal(cache["failed-vision-photo"].vision, "derived after retry");
});

test("an empty transcript result is cached and does not trigger another provider call", async () => {
  const before = { ...counts, daily: dailyEntries() };
  transcriptText = "";
  assert.equal(
    await deliver(voiceUpdate(707, "empty-transcript-voice")),
    "turn",
  );
  assert.equal(
    await deliver(voiceUpdate(708, "empty-transcript-voice")),
    "turn",
  );
  assert.equal(counts.download - before.download, 1);
  assert.equal(counts.transcript - before.transcript, 1);
  assert.equal(counts.turns - before.turns, 2);

  const cache = JSON.parse(
    readFileSync(join(dataDir, "media-cache.json"), "utf8"),
  );
  assert.equal(cache["empty-transcript-voice"].transcript, "");
});

test("a failed transcript result reuses the blob and retries the provider", async () => {
  const before = { ...counts, daily: dailyEntries() };
  transcriptStatus = 503;
  assert.equal(
    await deliver(voiceUpdate(709, "failed-transcript-voice")),
    "turn",
  );

  let cache = JSON.parse(
    readFileSync(join(dataDir, "media-cache.json"), "utf8"),
  );
  assert.equal(cache["failed-transcript-voice"].transcript, undefined);

  transcriptStatus = 200;
  transcriptText = "transcribed after retry";
  assert.equal(
    await deliver(voiceUpdate(710, "failed-transcript-voice")),
    "turn",
  );
  assert.equal(counts.download - before.download, 1);
  assert.equal(counts.transcript - before.transcript, 2);
  assert.equal(counts.turns - before.turns, 2);

  cache = JSON.parse(readFileSync(join(dataDir, "media-cache.json"), "utf8"));
  assert.equal(
    cache["failed-transcript-voice"].transcript,
    "transcribed after retry",
  );
});
