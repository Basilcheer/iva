import test from "node:test";
import assert from "node:assert/strict";
import { noticeSender } from "./outbox.ts";
import {
  notifyTelegramFailure,
  telegramFailureMessage,
} from "./telegram-failure-notice.ts";

// Собираем ровно то, что увидел бы Bot API: отправку модуль принимает только
// брендованную, поэтому коллектор оборачивается тем же швом, что и канал.
function collector() {
  const sent: string[] = [];
  return {
    sent,
    send: noticeSender((text: string) => {
      sent.push(text);
      return Promise.resolve(null);
    }),
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
    noticeSender(() => Promise.reject(new Error("Telegram 502"))),
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

// Служебная реплика канала не идёт через Outbox, но текст провайдера в ней —
// такой же runtime-контент: Gate обязан вычистить его до транспорта.
function muteErrors(t: { after: (fn: () => void) => void }): void {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

const PLANTED_KEY = `api_key=${"z".repeat(24)}`;
const PLANTED_BOT_TOKEN = `1234567890:${"A".repeat(35)}`;

await test("ключ из ошибки провайдера доезжает до чата отредактированным", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-key",
    { message: `Incorrect API key provided: ${PLANTED_KEY}` },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
  assert.match(sent[0], /\[REDACTED\]/u);
});

await test("пустая ошибка остаётся объяснимой, а не пустым сообщением", (t) => {
  muteErrors(t);

  assert.match(
    telegramFailureMessage({ message: "" }),
    /Unknown provider error$/u,
  );
});

// errorId приходит из eve нетронутым: в самой реплике его никто не чистит, и до чата
// он доезжает только через шов — ровно то свойство, ради которого шов и стоит.
await test("секрет в errorId вычищается швом, а не сборкой текста", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-error-id",
    {
      message: "Provider returned a strange response",
      details: { errorId: PLANTED_KEY },
    },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
  assert.match(sent[0], /Error id: \[REDACTED\]/u);
});

await test("многострочная ошибка: в чат уходит первая строка, и та без секрета", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-multiline",
    {
      message: `Provider returned a strange response ${PLANTED_KEY}\nstack line ${PLANTED_KEY}`,
      details: { errorId: "err-9" },
    },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
  assert.doesNotMatch(sent[0], /stack line/u);
  assert.match(sent[0], /Error id: err-9/u);
});

await test("телеграм-токен и ключ в одной ошибке редактятся оба", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-both",
    { message: `bot ${PLANTED_BOT_TOKEN} rejected: ${PLANTED_KEY}` },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
  assert.doesNotMatch(sent[0], /AAAA/u);
  assert.match(sent[0], /\[REDACTED\]/u);
});
