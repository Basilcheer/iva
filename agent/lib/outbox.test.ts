import assert from "node:assert/strict";
import test from "node:test";
import {
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

await test("транспорт без шанса на разметку останавливает шов", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: true }
        : { ok: false, error: "429: too many requests", retryPlain: false },
  });

  const result = await sendThroughOutbox(
    Array.from({ length: 400 }, (_, i) => `строка ${i} с текстом`).join("\n\n"),
    transport,
  );

  assert.deepEqual(result, {
    ok: false,
    delivered: 1,
    fellBack: false,
    error: "429: too many requests",
  });
  assert.equal(sent.length, 2);
});

await test("провал plain-повтора возвращается с пометкой повтора", async (t) => {
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
