import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  TELEGRAM_RESET_INTENT_VERSION,
  clearTelegramResetIntent,
  loadTelegramResetIntents,
  persistTelegramResetIntent,
} from "./telegram-reset-intent.ts";

async function intentDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-reset-intent-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "intents");
}

void test("reset intent persists, loads, clears, and tolerates missing paths", async (t) => {
  const directory = await intentDirectory(t);
  assert.deepEqual(await loadTelegramResetIntents(directory), []);

  const intent = await persistTelegramResetIntent(
    directory,
    "private:42",
    "telegram:42::",
    { now: () => 1234, nonce: () => "fixed" },
  );
  assert.deepEqual(intent, {
    version: TELEGRAM_RESET_INTENT_VERSION,
    chatKey: "private:42",
    continuationToken: "telegram:42::",
    requestedAt: 1234,
  });
  assert.deepEqual(await loadTelegramResetIntents(directory), [intent]);

  await clearTelegramResetIntent(directory, "private:42");
  await clearTelegramResetIntent(directory, "private:42");
  assert.deepEqual(await loadTelegramResetIntents(directory), []);
});

void test("reset intent loader rejects invalid records", async (t) => {
  const directory = await intentDirectory(t);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "bad.json"), "{}", "utf8");

  await assert.rejects(
    loadTelegramResetIntents(directory),
    /invalid Telegram reset intent/,
  );
});

void test("reset intent loader rejects a filename that does not match the chat", async (t) => {
  const directory = await intentDirectory(t);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "wrong.json"),
    JSON.stringify({
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey: "private:7",
      continuationToken: "telegram:7::",
      requestedAt: 7,
    }),
    "utf8",
  );

  await assert.rejects(
    loadTelegramResetIntents(directory),
    /filename does not match its chat key/,
  );
});
