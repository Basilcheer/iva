import assert from "node:assert/strict";
import test from "node:test";
import { dispatchCli } from "./main.ts";
import { createNotifyCommand, type NotifyDependencies } from "./notify.ts";
import { createCliRuntime } from "./runtime.ts";

const ROOT = "/tmp/iva-cli-notify-test";

type SendCall = readonly [bot: string, chat: string, text: unknown];

type SendResult = { ok: boolean; fellBack: boolean; error: string };

function notifyCommand(
  env: NodeJS.ProcessEnv,
  result: SendResult = { ok: true, fellBack: false, error: "" },
) {
  const sent: SendCall[] = [];
  const read: string[] = [];
  const messages: string[] = [];
  const base = createCliRuntime(ROOT);
  const dependencies: NotifyDependencies = {
    readEnv: (path) => {
      read.push(path);
      return Promise.resolve(env);
    },
    send: (bot, chat, md) => {
      sent.push([bot, chat, md]);
      return Promise.resolve(result);
    },
  };
  const cmdNotify = createNotifyCommand(
    {
      ...base,
      ok: (message) => {
        messages.push(message);
      },
    },
    dependencies,
  );
  return { cmdNotify, envPath: base.ENV_PATH, messages, read, sent };
}

void test("the digest chat receives the argument tail joined by single spaces", async () => {
  const notify = notifyCommand({
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    TELEGRAM_ALLOWED_USER_IDS: "777,888",
  });

  await notify.cmdNotify(["Позвонить", "врачу", "в", "17:00"]);

  assert.deepEqual(notify.read, [notify.envPath]);
  assert.deepEqual(notify.sent, [
    ["bot-token", "555", "Позвонить врачу в 17:00"],
  ]);
  assert.deepEqual(notify.messages, ["Sent to Telegram"]);
});

void test("without a digest chat the first allowed user gets the message", async () => {
  const notify = notifyCommand({
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "  ",
    TELEGRAM_ALLOWED_USER_IDS: " 42, 43",
  });

  await notify.cmdNotify(["напоминание"]);

  assert.deepEqual(notify.sent, [["bot-token", "42", "напоминание"]]);
});

void test("empty text, a missing token and a missing chat all fail before the network", async () => {
  for (const { args, env, expected } of [
    {
      args: [] as string[],
      env: { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_DIGEST_CHAT_ID: "555" },
      expected: "Nothing to send — usage: iva notify <text>",
    },
    {
      args: ["   "],
      env: { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_DIGEST_CHAT_ID: "555" },
      expected: "Nothing to send — usage: iva notify <text>",
    },
    {
      args: ["текст"],
      env: { TELEGRAM_DIGEST_CHAT_ID: "555" },
      expected: "TELEGRAM_BOT_TOKEN is missing — run: iva config",
    },
    {
      args: ["текст"],
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_USER_IDS: " , ",
      },
      expected:
        "No target chat — set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS in .env",
    },
  ]) {
    const notify = notifyCommand(env);

    await assert.rejects(notify.cmdNotify(args), { message: expected });

    assert.deepEqual(notify.sent, []);
    assert.deepEqual(notify.messages, []);
  }
});

void test("a refused send reports the Telegram error and exits one", async () => {
  const notify = notifyCommand(
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_DIGEST_CHAT_ID: "555" },
    { ok: false, fellBack: false, error: "403: bot was blocked by the user" },
  );
  const events: string[] = [];

  await assert.rejects(
    dispatchCli(
      ["notify", "текст"],
      { notify: notify.cmdNotify },
      {
        bad: (message) => events.push(`bad:${message}`),
        help: assert.fail,
        exit: (code): never => {
          events.push(`exit:${code}`);
          throw new Error(`exit ${code}`);
        },
      },
    ),
    { message: "exit 1" },
  );

  assert.deepEqual(events, [
    "bad:Telegram send failed: 403: bot was blocked by the user",
    "exit:1",
  ]);
  assert.deepEqual(notify.messages, []);
});
