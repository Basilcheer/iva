import test from "node:test";
import assert from "node:assert/strict";
import {
  notifyTelegramFailure,
  telegramFailureMessage,
} from "./telegram-failure-notice.ts";

function collector() {
  const sent: string[] = [];
  return {
    sent,
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve(null);
    },
  };
}

await test("turn.failed и session.failed об одной сессии объясняют сбой один раз", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-1", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-1", data, send, { now: 1_050 });

  assert.equal(sent.length, 1);
});

await test("другая сессия и повтор после TTL получают своё объяснение", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-2", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-3", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-2", data, send, { now: 61_001 });

  assert.equal(sent.length, 3);
});

await test("несостоявшаяся отправка возвращает заявку следующему событию", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure(
    "s-4",
    data,
    () => Promise.reject(new Error("Telegram 502")),
    { now: 1_000 },
  );
  await notifyTelegramFailure("s-4", data, send, { now: 1_100 });

  assert.equal(sent.length, 1);
});

await test("errorId из details попадает в текст, мусорные details его не ломают", () => {
  assert.match(
    telegramFailureMessage({
      message: "boom",
      details: { errorId: "err-77" },
    }),
    /\nError id: err-77$/u,
  );
  for (const details of [null, "err", ["err-77"], { errorId: 7 }, undefined]) {
    assert.doesNotMatch(
      telegramFailureMessage({ message: "boom", details }),
      /Error id:/u,
    );
  }
});
