/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Контракт ночной свёртки как ОТПРАВИТЕЛЯ. Сам rollup.ts запускается только против живого
// агента (eve/client), поэтому политика вынесена в scripts/lib/notices.ts и проверена там
// поведением; здесь проверяется проводка: что свёртка спрашивает тумблер, что доставка одна
// и что месяц с годом остались молчаливыми.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "rollup.ts"), "utf8");

/** Тело блока «этот период вообще может писать в Telegram», от заголовка до конца файла. */
function deliveryBlock(): string {
  const at = source.indexOf("if (REPORTS_TO_TELEGRAM[period]) {");
  assert.notEqual(at, -1, "the delivery block must stay one readable place");
  return source.slice(at);
}

test("monthly and yearly rollups stay silent, as they always were", () => {
  const table = /const REPORTS_TO_TELEGRAM[^;]+;/u.exec(source)?.[0] ?? "";
  assert.match(table, /daily: true/u);
  assert.match(table, /weekly: true/u);
  assert.match(table, /monthly: false/u);
  assert.match(table, /yearly: false/u);
});

test("the report leaves only after the owner's switch says yes", () => {
  const block = deliveryBlock();
  const gate = block.indexOf("if (!memoryReportsEnabled(readSettings()))");
  const send = block.indexOf("sendTelegramHtml(BOT, CHAT, result.message)");
  assert.notEqual(
    gate,
    -1,
    "the switch is read at delivery time, not at import",
  );
  assert.notEqual(send, -1);
  assert.ok(gate < send, "the switch is asked before the report is sent");
  // Выключено — выходим до отправки, а не «просто не логируем».
  assert.ok(
    block.slice(gate, send).includes("process.exit(0)"),
    "a switched-off report ends the run instead of falling through to the send",
  );
});

test("one run posts the report once, and nothing else posts at all", () => {
  // Две отправки во всём файле: сам отчёт и одноразовый Notice о выключении.
  assert.equal(source.split("sendTelegramHtml(").length - 1, 2);
  assert.equal(
    source.split("sendTelegramHtml(BOT, CHAT, result.message)").length - 1,
    1,
  );
  assert.equal(source.split("memoryReportsOffNotice(").length - 1, 1);
});

test("a fresh installation is never told about a report it never had", () => {
  const block = deliveryBlock();
  assert.match(
    block,
    /if \(RAN_BEFORE && BOT && CHAT\)/u,
    "the migration notice rides on evidence that this period ran here before",
  );
  assert.match(
    source,
    /const RAN_BEFORE = existsSync\(SESSION_FILE\);/u,
    "that evidence is read before the run saves its own cursor",
  );
  assert.ok(
    source.indexOf("const RAN_BEFORE") < source.indexOf("saveSession("),
    "reading it after the save would make every installation look fresh",
  );
});

test("the delivery half of the prompt is the one that carries the language", () => {
  assert.match(source, /const tail = memoryReportTail\(tr\);/u);
  // Хардкод старого хвоста ушёл целиком: иначе отчёт снова поедет на языке инструкции.
  assert.doesNotMatch(source, /what was created\/updated/u);
  assert.doesNotMatch(source, /Only the finished report/u);
  // Обработка карточек не тронута: язык добавлен только в доставку.
  assert.match(source, /Prefer the write_card tool over write_file/u);
  assert.match(source, /no H1\/H2 headings/u);
});
