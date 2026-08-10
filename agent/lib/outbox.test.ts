import assert from "node:assert/strict";
import test from "node:test";
import {
  redactNotice,
  sendThroughOutbox,
  type OutboxAck,
  type OutboxTransport,
} from "./outbox.ts";

const SECRET = `sk-${"a".repeat(24)}`;

type Sent = { kind: "rich" | "html" | "plain"; text: string };

type Replies = {
  rich?: (markdown: string) => OutboxAck;
  html?: (html: string, index: number) => OutboxAck;
  plain?: (text: string) => OutboxAck;
};

// Транспорт-заглушка: помнит всё, что шов реально отдал наружу, и отвечает по плану.
// sendRich появляется только когда план его описывает — как у настоящих транспортов.
function stub(replies: Replies = {}) {
  const sent: Sent[] = [];
  let htmlCalls = 0;
  const transport: OutboxTransport = {
    sendHtml(html) {
      sent.push({ kind: "html", text: html });
      return Promise.resolve(replies.html?.(html, htmlCalls++) ?? { ok: true });
    },
    sendPlain(text) {
      sent.push({ kind: "plain", text });
      return Promise.resolve(replies.plain?.(text) ?? { ok: true });
    },
  };
  if (replies.rich) {
    const rich = replies.rich;
    transport.sendRich = (markdown) => {
      sent.push({ kind: "rich", text: markdown });
      return Promise.resolve(rich(markdown));
    };
  }
  return { sent, transport };
}

// Гейт логирует находки в console.error — ловим лог, не подменяя поведение доставки.
function captureErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

await test("Gate редактит утёкший секрет до транспорта и логирует находку", async (t) => {
  const logged = captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox(`ключ: ${SECRET} — держи`, transport);

  assert.deepEqual(result, {
    ok: true,
    delivered: 1,
    fellBack: false,
    error: "",
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes(SECRET));
  assert.ok(sent[0].text.includes("[REDACTED]"));
  assert.equal(logged.length, 1);
  assert.ok(logged[0].startsWith("[security] outbound leak redacted:"));
  assert.ok(logged[0].includes("api_key:openai"));
});

await test("чистое сообщение уходит без записи в лог", async (t) => {
  const logged = captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox("обычный ответ", transport);

  assert.equal(result.ok, true);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["html"],
  );
  assert.deepEqual(logged, []);
});

await test("секрет не выживает ни на одном маршруте доставки", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    // Таблица уводит в rich, rich отвергнут, HTML тоже — остаётся plain-фолбэк.
    rich: () => ({ ok: false, error: "rich rejected", retryPlain: false }),
    html: () => ({ ok: false, error: "400: bad entities", retryPlain: true }),
  });

  const result = await sendThroughOutbox(
    `| ключ | значение |\n|---|---|\n| api | ${SECRET} |`,
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.fellBack, true);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["rich", "html", "plain"],
  );
  for (const message of sent) assert.ok(!message.text.includes(SECRET));
});

await test("длинное сообщение режется на чанки в пределах лимита", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox(
    Array.from({ length: 400 }, (_, i) => `строка ${i} с текстом`).join("\n\n"),
    transport,
  );

  assert.equal(result.ok, true);
  assert.ok(result.delivered > 1);
  assert.equal(sent.length, result.delivered);
  for (const message of sent) {
    assert.equal(message.kind, "html");
    assert.ok(message.text.length <= 4096);
    assert.ok(message.text.length > 0);
  }
  assert.ok(sent.at(-1)?.text.includes("строка 399"));
});

await test("лимит подписи режет мельче стандартного", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox(
    Array.from({ length: 200 }, (_, i) => `подпись ${i}`).join("\n\n"),
    transport,
    { limit: 1024 },
  );

  assert.equal(result.ok, true);
  assert.ok(sent.length > 1);
  for (const message of sent) assert.ok(message.text.length <= 1024);
});

await test("пустое сообщение и один пробел не порождают отправку", async (t) => {
  captureErrors(t);
  for (const message of ["", "   ", "\n\t \n"]) {
    const { sent, transport } = stub();
    const result = await sendThroughOutbox(message, transport);
    assert.deepEqual(result, {
      ok: true,
      delivered: 0,
      fellBack: false,
      error: "",
    });
    assert.deepEqual(sent, []);
  }
});

await test("разметка экранируется, а plain-фолбэк её декодирует", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: () => ({ ok: false, error: "400: bad entities", retryPlain: true }),
  });

  const result = await sendThroughOutbox(
    "<script>alert(1)</script> & <b>жирный</b>",
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.fellBack, true);
  assert.equal(result.delivered, 1);
  const [html, plain] = sent;
  assert.equal(html.kind, "html");
  assert.ok(html.text.includes("&lt;script&gt;"));
  assert.ok(!html.text.includes("<script>"));
  assert.equal(plain.kind, "plain");
  assert.ok(plain.text.includes("<script>alert(1)</script>"));
  assert.ok(!plain.text.includes("&lt;"));
  assert.ok(!plain.text.includes("&amp;"));
});

const LONG_MESSAGE = Array.from(
  { length: 400 },
  (_, i) => `строка ${i} с текстом`,
).join("\n\n");

// Сколько чанков даёт LONG_MESSAGE — считаем доставкой без единого отказа, чтобы
// тесты ниже говорили «все, кроме одного», а не сверялись с магическим числом.
async function chunkCount(message: string): Promise<number> {
  const { sent, transport } = stub();
  await sendThroughOutbox(message, transport);
  return sent.length;
}

await test("сбой одного чанка не хоронит остальные", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: false, error: "429: too many requests", retryPlain: false }
        : { ok: true },
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  // Пользователь теряет один кусок ответа, а не весь хвост: остальные чанки ушли.
  assert.deepEqual(result, {
    ok: false,
    delivered: total - 1,
    fellBack: false,
    error: "429: too many requests",
  });
  assert.equal(sent.length, total);
  assert.ok(sent.at(-1)?.text.includes("строка 399"));
});

await test("stop от транспорта обрывает доставку хвоста", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? {
            ok: false,
            error: "429: flood control",
            retryPlain: false,
            stop: true,
          }
        : { ok: true },
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  // Telegram душит бота — шов не долбит его оставшимися 45 запросами.
  assert.ok(total > 1);
  assert.deepEqual(result, {
    ok: false,
    delivered: 0,
    fellBack: false,
    error: "429: flood control",
  });
  assert.equal(sent.length, 1);
});

await test("stop на plain-повторе обрывает доставку хвоста", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: false, error: "400: bad entities", retryPlain: true }
        : { ok: true },
    plain: () => ({
      ok: false,
      error: "403: bot was blocked",
      retryPlain: false,
      stop: true,
    }),
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  assert.ok(total > 1);
  assert.deepEqual(result, {
    ok: false,
    delivered: 0,
    fellBack: true,
    error: "plain retry 403: bot was blocked",
  });
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["html", "plain"],
  );
});

await test("провал plain-повтора помечает шов, но доставка продолжается", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: false, error: "400: bad entities", retryPlain: true }
        : { ok: true },
    plain: () => ({ ok: false, error: "500: server error", retryPlain: false }),
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  assert.deepEqual(result, {
    ok: false,
    delivered: total - 1,
    fellBack: true,
    error: "plain retry 500: server error",
  });
  assert.equal(sent.filter((s) => s.kind === "plain").length, 1);
  assert.equal(sent.filter((s) => s.kind === "html").length, total);
});

await test("шов сообщает первую ошибку, даже если упало несколько чанков", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: (_html, index) => ({
      ok: false,
      error: `50${index}: server error`,
      retryPlain: false,
    }),
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.error, "500: server error");
  assert.ok(sent.length > 1);
});

await test("единственный чанк, упавший дважды, возвращается с пометкой повтора", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: () => ({ ok: false, error: "400: bad entities", retryPlain: true }),
    plain: () => ({ ok: false, error: "500: server error", retryPlain: false }),
  });

  const result = await sendThroughOutbox("ответ", transport);

  assert.deepEqual(result, {
    ok: false,
    delivered: 0,
    fellBack: true,
    error: "plain retry 500: server error",
  });
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["html", "plain"],
  );
});

await test("таблица уходит одним rich-сообщением, обычный текст — нет", async (t) => {
  captureErrors(t);
  const rich = stub({ rich: () => ({ ok: true }) });
  const richResult = await sendThroughOutbox(
    "| a | b |\n|---|---|\n| 1 | 2 |",
    rich.transport,
  );
  assert.deepEqual(richResult, {
    ok: true,
    delivered: 1,
    fellBack: false,
    error: "",
  });
  assert.deepEqual(
    rich.sent.map((s) => s.kind),
    ["rich"],
  );

  const prose = stub({ rich: () => ({ ok: true }) });
  await sendThroughOutbox("просто текст", prose.transport);
  assert.deepEqual(
    prose.sent.map((s) => s.kind),
    ["html"],
  );
});

await test("отказ rich-сообщения проваливается в HTML-путь", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    rich: () => ({
      ok: false,
      error: "400: rich unsupported",
      retryPlain: false,
    }),
  });

  const result = await sendThroughOutbox(
    "| a | b |\n|---|---|\n| 1 | 2 |",
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.delivered, 1);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["rich", "html"],
  );
});

await test("redactNotice проводит служебное уведомление через тот же Gate", (t) => {
  const logged = captureErrors(t);
  const planted = `api_key=${"z".repeat(24)}`;

  const text = redactNotice(`build failed: ${planted}`);

  assert.equal(text, "build failed: [REDACTED]");
  assert.match(
    logged.join("\n"),
    /outbound leak redacted: api_key:generic_key/u,
  );
});

await test("redactNotice не трогает чистый текст и переживает пустой", (t) => {
  const logged = captureErrors(t);

  assert.equal(redactNotice("Iva обновлена"), "Iva обновлена");
  assert.equal(redactNotice(""), "");
  assert.deepEqual(logged, []);
});

await test("redactNotice чистит многострочное уведомление целиком", (t) => {
  captureErrors(t);
  const planted = `api_key=${"z".repeat(24)}`;

  const text = redactNotice(`line one\nline two ${planted}\nline three`);

  assert.equal(text, "line one\nline two [REDACTED]\nline three");
});
