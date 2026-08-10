/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { redactNotice, redactTelegramBody } from "./notice.ts";

const PLANTED = `api_key=${"z".repeat(24)}`;
const BOT_TOKEN = `1234567890:${"A".repeat(35)}`;

function muteErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((argument) => String(argument)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

test("a CLI-side notice is redacted by the outbound Gate", async (t) => {
  muteErrors(t);

  assert.equal(
    await redactNotice(`build failed: ${PLANTED}`),
    "build failed: [REDACTED]",
  );
});

test("a notice still goes out when the authored tree is not there", async (t) => {
  const errors = muteErrors(t);

  const text = await redactNotice(`build failed: ${PLANTED}`, () =>
    Promise.reject(new Error("Cannot find module")),
  );

  assert.equal(text, `build failed: ${PLANTED}`);
  assert.match(errors.join("\n"), /gate unavailable/u);
});

test("a Bot API body is gated in the fields the chat sees", async (t) => {
  muteErrors(t);

  assert.deepEqual(
    await redactTelegramBody({
      chat_id: 7,
      text: `doctor: ${PLANTED}`,
      caption: `log: ${PLANTED}`,
      reply_markup: { inline_keyboard: [] },
    }),
    {
      chat_id: 7,
      text: "doctor: [REDACTED]",
      caption: "log: [REDACTED]",
      reply_markup: { inline_keyboard: [] },
    },
  );
});

test("a body with nothing for the chat comes back as it went in", async (t) => {
  muteErrors(t);
  const poll = { offset: 42, timeout: 50 };

  assert.equal(await redactTelegramBody(poll), poll);
  assert.equal(await redactTelegramBody(undefined), undefined);
  // A clean edit keeps its identity too: callers dedupe on the body they passed.
  const clean = { text: "🛠 Обслуживание" };
  assert.equal(await redactTelegramBody(clean), clean);
});

test("a gated body survives an empty, a multi-line and a two-secret text", async (t) => {
  muteErrors(t);
  const gated = async (text: string) =>
    (await redactTelegramBody({ text })).text;

  assert.equal(await gated(""), "");
  assert.equal(
    await gated(`Traceback:\n  env: ${PLANTED}\n  exit 1`),
    "Traceback:\n  env: [REDACTED]\n  exit 1",
  );
  // Both the bot token and a provider key in one command dump.
  const both = await gated(`curl -sS bot${BOT_TOKEN} -H "${PLANTED}"`);
  assert.doesNotMatch(both, /zzzz/u);
  assert.doesNotMatch(both, new RegExp(BOT_TOKEN, "u"));
  assert.equal(both, 'curl -sS bot[REDACTED] -H "[REDACTED]"');
});
