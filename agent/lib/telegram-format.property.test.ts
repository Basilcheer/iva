// Свойства конвертера Telegram-разметки на случайном тексте. Якоря контракта — в
// telegram-format.test.ts, здесь генератор перебирает то, чего фантазия автора не
// покрывает: цифры вперемешку с пачками пробелов и code-span посреди обычной прозы.
// Ровно на этом ломалась старая метка code-span, а ломалась она молча — текст просто
// не доезжал до чата (ADR-0002).
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  BUTTON_DATA_MAX_BYTES,
  escHtml,
  htmlToPlain,
  mdToTelegramHtml,
  shortenButtonData,
  shortenButtonsData,
} from "./telegram-format.ts";

const SEED = 20_260_818;
const RUNS = 500;

// Алфавит прозы: буквы, цифры и пробелы пачками по 1–4 — ровно то, из чего
// складывалась прежняя метка. Управляющих символов разметки в нём нет, поэтому строка
// гарантированно идёт по ветке обычной строки в convert(): ни фенсом, ни таблицей, ни
// заголовком, ни цитатой, ни списком, ни горизонтальной чертой она стать не может.
const proseUnit = fc.constantFrom(
  ..."abcxyzABCXYZабвэюя0123456789",
  " ",
  "  ",
  "   ",
  "    ",
);
const prose = fc.string({ unit: proseUnit, maxLength: 12 });

// Тело code-span: любой юникод, кроме обратной кавычки (она закрыла бы span раньше
// времени), переводов строки (convert режет вход по строкам ДО inlineHtml) и самих
// символов метки (их inlineHtml срезает на входе).
const codeBody = fc
  .string({ unit: "binary", minLength: 1, maxLength: 24 })
  .filter((body) => !/[`\n\r\uE000\uE001]/.test(body));

await test(`обычная проза переживает конвертацию без потерь (seed ${SEED})`, () => {
  fc.assert(
    fc.property(prose, (text) => {
      // Единственная честная нормализация такой строки — финальный trim() всего
      // вывода в convert(): inlineHtml её не трогает (escHtml нечего экранировать,
      // ни одна inline-регулярка не срабатывает), а htmlToPlain нечего распаковывать.
      // Поэтому сравниваем с text.trim(), а не с text: более сильное утверждение было
      // бы неправдой, более слабое пропустило бы ровно ту потерю, которую ищем.
      assert.equal(htmlToPlain(mdToTelegramHtml(text)), text.trim());
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

await test(`code-span восстанавливается ровно один раз (seed ${SEED})`, () => {
  fc.assert(
    fc.property(prose, prose, codeBody, (before, after, body) => {
      const html = mdToTelegramHtml(`${before}\`${body}\`${after}`);
      const spans = html.match(/<code>[\s\S]*?<\/code>/g) ?? [];

      assert.equal(spans.length, 1);
      assert.equal(spans[0], `<code>${escHtml(body)}</code>`);
      // Проза вокруг span остаётся в тексте. Общий trim() съедает только внешние
      // пробелы всей строки, поэтому сравниваем по обрезанным краям.
      const plain = htmlToPlain(html);
      assert.ok(plain.includes(before.trim()));
      assert.ok(plain.includes(after.trim()));
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

// Data кнопки: любой юникод, с упором на многобайтовые символы — кириллица (2 байта),
// евро (3), эмодзи (4, суррогатная пара в JS) и составные эмодзи, плюс HTML-сущность.
const dataUnit = fc.oneof(
  fc.constantFrom("а", "я", "€", "😀", "👍🏽", "👨‍👩‍👧", "a", " ", ",", "&amp;"),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
);
const buttonData = fc
  .string({ unit: dataUnit, maxLength: 60 })
  .filter((data) => !data.includes('"'));

const ENTITY_IN_DATA = /&(?:#\d+|#x[\da-f]+|[a-z]+);/giu;

const isWellFormedUtf8 = (text: string): boolean =>
  Buffer.from(text, "utf8").toString("utf8") === text;

await test(`data кнопки: ≤ 64 байт, целые символы, начало исходного (seed ${SEED})`, () => {
  fc.assert(
    fc.property(buttonData, (data) => {
      const short = shortenButtonData(data);
      assert.ok(Buffer.byteLength(short) <= BUTTON_DATA_MAX_BYTES);
      assert.ok(isWellFormedUtf8(short), "a multibyte character was split");
      assert.ok(data.startsWith(short));
      // HTML-сущность исходного data в результате либо целиком, либо её нет вовсе.
      for (const entity of data.matchAll(ENTITY_IN_DATA))
        assert.ok(
          entity.index >= short.length ||
            entity.index + entity[0].length <= short.length,
          `entity ${entity[0]} at ${entity.index} cut: ${short}`,
        );
      if (Buffer.byteLength(data) <= BUTTON_DATA_MAX_BYTES)
        assert.equal(short, data);
      // Отрезано не больше нужного: следующий символ уже не влез бы.
      else if (!data.includes("&")) {
        const next = [...data.slice(short.length)][0];
        assert.ok(Buffer.byteLength(short + next) > BUTTON_DATA_MAX_BYTES);
      }
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

await test(`разметка кнопок: укорачивается только data, подписи и текст целы (seed ${SEED})`, (t) => {
  t.mock.method(console, "error", () => {});
  fc.assert(
    fc.property(
      fc.array(buttonData, { minLength: 1, maxLength: 4 }),
      fc.boolean(),
      (tails, sharedHead) => {
        // Половина прогонов — общее длинное начало: после укорачивания data совпали бы.
        const datas = sharedHead
          ? tails.map((tail) => `${"Общее начало кнопок ".repeat(3)}${tail}`)
          : tails;
        const md = datas
          .map(
            (data, index) =>
              `<tg-button type="callback_data" data="${data}">Кнопка ${index}</tg-button> — пояснение ${index}`,
          )
          .join("\n");
        const out = shortenButtonsData(md);
        const shortened = [...out.matchAll(/\sdata="([^"]*)"/g)].map(
          (match) => match[1],
        );
        assert.equal(shortened.length, datas.length);
        shortened.forEach((data, index) => {
          const original = datas[index];
          assert.ok(Buffer.byteLength(data) <= BUTTON_DATA_MAX_BYTES);
          if (Buffer.byteLength(original) <= BUTTON_DATA_MAX_BYTES) {
            assert.equal(data, original);
            return;
          }
          // Укороченный: начало исходного, при совпадении с кнопкой выше — с хвостом «#N».
          assert.ok(original.startsWith(data.replace(/#\d+$/u, "")));
          assert.ok(!shortened.slice(0, index).includes(data), data);
        });
        assert.equal(
          out.replace(/\sdata="[^"]*"/g, ""),
          md.replace(/\sdata="[^"]*"/g, ""),
        );
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});

await test("две кнопки с общим началом длиннее 64 байт остаются различимыми", (t) => {
  t.mock.method(console, "error", () => {});
  const head = "Задачи на неделю: закрыть тесты, привычки ";
  const md = [
    `<tg-button type="callback_data" data="${head}без срока">Без срока</tg-button>`,
    `<tg-button type="callback_data" data="${head}со сроком на пятницу">Пятница</tg-button>`,
    `<tg-button type="callback_data" data="${head}перенести">Перенести</tg-button>`,
  ].join("\n");

  const datas = [...shortenButtonsData(md).matchAll(/\sdata="([^"]*)"/g)].map(
    (match) => match[1],
  );

  assert.equal(new Set(datas).size, 3, datas.join(" | "));
  for (const data of datas)
    assert.ok(Buffer.byteLength(data) <= BUTTON_DATA_MAX_BYTES, data);
  assert.equal(datas[0], shortenButtonData(`${head}без срока`));
  assert.match(datas[1], /#2$/u);
  assert.match(datas[2], /#3$/u);
});

await test("сущность на границе 64 байт не рвётся: уходит целиком следующим атомом", () => {
  // 62 байта текста, дальше «&amp;»: два его байта влезли бы, но сущность — один атом.
  const data = `${"x".repeat(62)}&amp;хвост`;
  assert.equal(shortenButtonData(data), "x".repeat(62));
  assert.equal(
    shortenButtonData(`${"x".repeat(59)}&amp;хвост`),
    `${"x".repeat(59)}&amp;`,
  );
});
